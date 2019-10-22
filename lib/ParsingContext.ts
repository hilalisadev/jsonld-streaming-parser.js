import {ContextParser, IExpandOptions, IJsonLdContextNormalized} from "jsonld-context-parser";
import {JsonLdContext} from "jsonld-context-parser/lib/JsonLdContext";
import * as RDF from "rdf-js";
import {ContextTree} from "./ContextTree";
import {IJsonLdParserOptions, JsonLdParser} from "./JsonLdParser";

/**
 * Data holder for parsing information.
 */
export class ParsingContext {

  public static EXPAND_OPTIONS: {[version: number]: IExpandOptions} = {
    1.0: {
      allowNonGenDelimsIfPrefix: false,
      allowVocabRelativeToBase: false,
    },
    1.1: {
      allowNonGenDelimsIfPrefix: true,
      allowVocabRelativeToBase: true,
    },
  };

  public readonly contextParser: ContextParser;
  public readonly allowOutOfOrderContext: boolean;
  public readonly baseIRI: string;
  public readonly produceGeneralizedRdf: boolean;
  public readonly allowSubjectList: boolean;
  public readonly processingMode: string;
  public readonly errorOnInvalidProperties: boolean;
  public readonly validateValueIndexes: boolean;
  public readonly strictRanges: boolean;
  public readonly rootContext: Promise<IJsonLdContextNormalized>;
  public readonly defaultGraph?: RDF.Term;

  // Stack of indicating if a depth has been touched.
  public readonly processingStack: boolean[];
  // Stack of indicating if triples have been emitted (or will be emitted) at each depth.
  public readonly emittedStack: boolean[];
  // Stack of identified ids, tail can be null if unknown
  public readonly idStack: RDF.Term[];
  // Stack of graph flags
  public readonly graphStack: boolean[];
  // Stack of RDF list pointers (for @list)
  public readonly listPointerStack: { term: RDF.Term, initialPredicate: RDF.Term, listRootDepth: number }[];
  // Stack of active contexts
  public readonly contextTree: ContextTree;
  // Stack of flags indicating if the node is a literal
  public readonly literalStack: boolean[];
  // Stack with validation results.
  public readonly validationStack: { valid: boolean, property: boolean }[];
  // Stack with cached unaliased keywords.
  public readonly unaliasedKeywordCacheStack: any[];
  // Triples that don't know their subject @id yet.
  // L0: stack depth; L1: values
  public readonly unidentifiedValuesBuffer: { predicate: RDF.Term, object: RDF.Term, reverse: boolean }[][];
  // Quads that don't know their graph @id yet.
  // L0: stack depth; L1: values
  public readonly unidentifiedGraphsBuffer: { subject: RDF.Term, predicate: RDF.Term, object: RDF.Term }[][];

  // If there are top-level properties
  public topLevelProperties: boolean;
  // The processing mode that was defined in the document's context
  public activeProcessingMode: number;

  private readonly parser: JsonLdParser;

  constructor(options: IParsingContextOptions) {
    // Initialize settings
    this.contextParser = new ContextParser({ documentLoader: options.documentLoader });
    this.allowOutOfOrderContext = options.allowOutOfOrderContext;
    this.baseIRI = options.baseIRI;
    this.produceGeneralizedRdf = options.produceGeneralizedRdf;
    this.allowSubjectList = options.allowSubjectList;
    this.processingMode = options.processingMode || JsonLdParser.DEFAULT_PROCESSING_MODE;
    this.errorOnInvalidProperties = options.errorOnInvalidIris;
    this.validateValueIndexes = options.validateValueIndexes;
    this.strictRanges = options.strictRanges;
    this.defaultGraph = options.defaultGraph;

    // Initialize stacks
    this.processingStack = [];
    this.emittedStack = [];
    this.idStack = [];
    this.graphStack = [];
    this.listPointerStack = [];
    this.contextTree = new ContextTree();
    this.literalStack = [];
    this.validationStack = [];
    this.unaliasedKeywordCacheStack = [];
    this.unidentifiedValuesBuffer = [];
    this.unidentifiedGraphsBuffer = [];

    this.parser = options.parser;
    if (options.context) {
      this.rootContext = this.contextParser.parse(options.context, { baseIri: options.baseIRI });
      this.rootContext.then((context) => this.validateContext(context));
    } else {
      this.rootContext = Promise.resolve(this.baseIRI ? { '@base': this.baseIRI } : {});
    }

    this.topLevelProperties = false;
    this.activeProcessingMode = parseFloat(this.processingMode);
  }

  /**
   * Check if the given context is valid.
   * If not, an error will be thrown.
   * @param {IJsonLdContextNormalized} context A context.
   */
  public validateContext(context: IJsonLdContextNormalized) {
    const activeVersion: number = <number> <any> context['@version'];
    if (activeVersion && activeVersion > parseFloat(this.processingMode)) {
      throw new Error(`Unsupported JSON-LD processing mode: ${activeVersion}`);
    } else {
      this.activeProcessingMode = activeVersion;
    }
  }

  /**
   * Get the context at the given path.
   * @param {keys} keys The path of keys to get the context at.
   * @param {number} offset The path offset, defaults to 1.
   * @return {Promise<IJsonLdContextNormalized>} A promise resolving to a context.
   */
  public getContext(keys: string[], offset = 1): Promise<IJsonLdContextNormalized> {
    if (offset) {
      keys = keys.slice(0, -offset);
    }
    return this.contextTree.getContext(keys) || this.rootContext;
  }

  /**
   * Start a new job for parsing the given value.
   * @param {any[]} keys The stack of keys.
   * @param value The value to parse.
   * @param {number} depth The depth to parse at.
   * @return {Promise<void>} A promise resolving when the job is done.
   */
  public async newOnValueJob(keys: any[], value: any, depth: number) {
    await this.parser.newOnValueJob(keys, value, depth);
  }

  /**
   * Emit the given quad into the output stream.
   * @param {number} depth The depth the quad was generated at.
   * @param {Quad} quad A quad to emit.
   */
  public emitQuad(depth: number, quad: RDF.BaseQuad) {
    if (depth === 1) {
      this.topLevelProperties = true;
    }
    this.parser.push(quad);
  }

  /**
   * Emit the given error into the output stream.
   * @param {Error} error An error to emit.
   */
  public emitError(error: Error) {
    this.parser.emit('error', error);
  }

  /**
   * Emit the given context into the output stream under the 'context' event.
   * @param {JsonLdContext} context A context to emit.
   */
  public emitContext(context: JsonLdContext) {
    this.parser.emit('context', context);
  }

  /**
   * Safely get or create the depth value of {@link ParsingContext.unidentifiedValuesBuffer}.
   * @param {number} depth A depth.
   * @return {{predicate: Term; object: Term; reverse: boolean}[]} An element of
   *                                                               {@link ParsingContext.unidentifiedValuesBuffer}.
   */
  public getUnidentifiedValueBufferSafe(depth: number): { predicate: RDF.Term, object: RDF.Term, reverse: boolean }[] {
    let buffer = this.unidentifiedValuesBuffer[depth];
    if (!buffer) {
      buffer = [];
      this.unidentifiedValuesBuffer[depth] = buffer;
    }
    return buffer;
  }

  /**
   * Safely get or create the depth value of {@link ParsingContext.unidentifiedGraphsBuffer}.
   * @param {number} depth A depth.
   * @return {{predicate: Term; object: Term; reverse: boolean}[]} An element of
   *                                                               {@link ParsingContext.unidentifiedGraphsBuffer}.
   */
  public getUnidentifiedGraphBufferSafe(depth: number): { subject: RDF.Term, predicate: RDF.Term, object: RDF.Term }[] {
    let buffer = this.unidentifiedGraphsBuffer[depth];
    if (!buffer) {
      buffer = [];
      this.unidentifiedGraphsBuffer[depth] = buffer;
    }
    return buffer;
  }

  /**
   * @return IExpandOptions The expand options for the active processing mode.
   */
  public getExpandOptions(): IExpandOptions {
    return ParsingContext.EXPAND_OPTIONS[this.activeProcessingMode];
  }

}

/**
 * Constructor arguments for {@link ParsingContext}
 */
export interface IParsingContextOptions extends IJsonLdParserOptions {
  /**
   * The parser instance.
   */
  parser: JsonLdParser;
}
