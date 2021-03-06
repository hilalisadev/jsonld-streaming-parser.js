import * as RDF from "rdf-js";
import {ParsingContext} from "../ParsingContext";
import {Util} from "../Util";
import {IEntryHandler} from "./IEntryHandler";

/**
 * Handles values that are part of an array.
 */
export class EntryHandlerArrayValue implements IEntryHandler<boolean> {

  public isPropertyHandler(): boolean {
    return false;
  }

  public async validate(parsingContext: ParsingContext, util: Util, keys: any[], depth: number, inProperty: boolean)
    : Promise<boolean> {
    return this.test(parsingContext, util, null, keys, depth);
  }

  public async test(parsingContext: ParsingContext, util: Util, key: any, keys: any[], depth: number)
    : Promise<boolean> {
    return typeof keys[depth] === 'number';
  }

  public async handle(parsingContext: ParsingContext, util: Util, key: any, keys: any[], value: any, depth: number)
    : Promise<any> {
    const parentKey = await util.unaliasKeywordParent(keys, depth);

    // Check if we have an anonymous list
    if (parentKey === '@list') {
      // Our value is part of an array

      // Determine the list root key
      let listRootKey = null;
      let listRootDepth;
      for (let i = depth - 2; i > 0; i--) {
        const keyOption = keys[i];
        if (typeof keyOption === 'string') {
          listRootDepth = i;
          listRootKey = keyOption;
          break;
        }
      }

      // Throw an error if we encounter a nested list
      if (listRootKey === '@list' ||
        (listRootDepth !== depth - 2 && typeof keys[depth - 2] === 'number'
          && Util.getContextValueContainer(await parsingContext
            .getContext(keys, listRootDepth - depth), listRootKey) === '@list')) {
        throw new Error(`Lists of lists are not supported: '${listRootKey}'`);
      }

      const object = await util.valueToTerm(await parsingContext.getContext(keys), listRootKey, value, depth, keys);

      if (listRootKey !== null) {
        await this.handleListElement(parsingContext, util, object, depth, keys.slice(0, listRootDepth), listRootDepth,
          listRootKey, keys);
      }
    } else if (parentKey === '@set') {
      // Our value is part of a set, so we just add it to the parent-parent
      await parsingContext.newOnValueJob(keys.slice(0, -2), value, depth - 2);
    } else if (parentKey !== undefined && parentKey !== '@type') {
      // Buffer our value using the parent key as predicate

      // Check if the predicate is marked as an @list in the context
      const parentContext = await parsingContext.getContext(keys.slice(0, -1));
      if (Util.getContextValueContainer(parentContext, parentKey) === '@list') {
        // Our value is part of an array
        const object = await util.valueToTerm(await parsingContext.getContext(keys), parentKey, value, depth, keys);
        await this.handleListElement(parsingContext, util, object, depth, keys.slice(0, -1), depth - 1,
          parentKey, keys);
      } else {
        // Copy the id stack value up one level so that the next job can access the id.
        if (parsingContext.idStack[depth + 1]) {
          parsingContext.idStack[depth] = parsingContext.idStack[depth + 1];
          parsingContext.emittedStack[depth] = true;
        }

        // Execute the job one level higher
        await parsingContext.newOnValueJob(keys.slice(0, -1), value, depth - 1);

        // Remove any defined contexts at this level to avoid it to propagate to the next array element.
        parsingContext.contextTree.removeContext(keys.slice(0, -1));
      }
    }
  }

  protected async handleListElement(parsingContext: ParsingContext, util: Util, value: RDF.Term, depth: number,
                                    listRootKeys: string[], listRootDepth: number, listRootKey: string, keys: any[]) {
        // Buffer our value as an RDF list using the listRootKey as predicate
    let listPointer = parsingContext.listPointerStack[depth];

    if (value) {
      if (!listPointer || !listPointer.term) {
        const linkTerm: RDF.BlankNode = util.dataFactory.blankNode();
        const listRootContext = await parsingContext.getContext(listRootKeys);
        const predicate = await util.predicateToTerm(listRootContext, listRootKey);
        const reverse = Util.isPropertyReverse(listRootContext, listRootKey, keys[listRootDepth - 1]);

        // Lists are not allowed in @reverse'd properties
        if (reverse && !parsingContext.allowSubjectList) {
          throw new Error(`Found illegal list value in subject position at ${listRootKey}`);
        }

        parsingContext.getUnidentifiedValueBufferSafe(listRootDepth)
          .push({ predicate, object: linkTerm, reverse });
        listPointer = { term: linkTerm, initialPredicate: null, listRootDepth };
      } else {
        // rdf:rest links are always emitted before the next element,
        // as the blank node identifier is only created at that point.
        // Because of this reason, the final rdf:nil is emitted when the stack depth is decreased.
        const newLinkTerm: RDF.Term = util.dataFactory.blankNode();
        parsingContext.emitQuad(depth, util.dataFactory.quad(listPointer.term, util.rdfRest, newLinkTerm,
          util.getDefaultGraph()));

        // Update the list pointer for the next element
        listPointer.term = newLinkTerm;
      }

      // Emit a list element for the current value
      parsingContext.emitQuad(depth, util.dataFactory.quad(listPointer.term, util.rdfFirst, value,
        util.getDefaultGraph()));
    } else {
      // A falsy list element if found.
      // Just enable the list flag for this depth if it has not been set before.
      if (!listPointer) {
        const predicate = await util.predicateToTerm(await parsingContext.getContext(listRootKeys), listRootKey);
        listPointer = { term: null, initialPredicate: predicate, listRootDepth };
      }
    }

    parsingContext.listPointerStack[depth] = listPointer;
  }

}
