/**
 * Retrieval over a caller-supplied document corpus, plus the example builder
 * that `generate-example` uses.
 *
 * WHY A CORPUS THE CALLER PASSES IN: an "assistant" that answers from a model's
 * own weights cannot show where an answer came from, and this package has no
 * model. Everything here is lexical and every answer is a span of text the
 * caller handed us, carrying the id of the document it was quoted from. That is
 * the difference between an answer and a guess that looks like one.
 *
 * SCORING, STATED ONCE SO NO CALLER HAS TO GUESS: a document and a question are
 * each reduced to the SET of their content terms (`tokenize` drops stop words
 * and one-character tokens). Each term is weighted by its inverse document
 * frequency over the corpus, ln(1 + N/df), and the score is the cosine of the
 * two weighted sets:
 *
 *     score(q, d) = sum over t in q and d of idf(t)^2
 *                   / ( sqrt(sum over t in q of idf(t)^2)
 *                       * sqrt(sum over t in d of idf(t)^2) )
 *
 * so a score is in [0, 1], is 0 exactly when the two share no term, and is
 * comparable only within one corpus -- changing the corpus changes every idf.
 *
 * Binary presence rather than term counts is deliberate: a document that
 * repeats a word is not more relevant to a question that mentions it once, and
 * raw counts make a long document outrank a short exact match.
 *
 * WHY NOT `cosineSimilarity` FROM `analytics-core`: that one takes two dense
 * vectors of equal length and requires at least two samples. The vectors here
 * are sparse over a vocabulary that can legitimately be a single term, so the
 * sum is taken over the sparse sets directly, with the same algebra.
 */

import type { JsonSchemaNode } from '../../validation/schema-from-definition.js';
import {
  inverseDocumentFrequency,
  splitSentences,
  tokenize,
} from './text-core.js';

/** One document of the corpus a caller passes in. */
export interface KnowledgeDocument {
  id: string;
  title?: string;
  text: string;
  tags?: readonly string[];
}

/**
 * Validate a corpus, naming the first offending document. A corpus with two
 * documents under one id would make every answer's citation ambiguous, and an
 * empty document would silently contribute a document-frequency denominator to
 * every idf while never matching anything.
 */
export const validateDocuments = (
  documents: unknown,
  label: string
): KnowledgeDocument[] => {
  if (!Array.isArray(documents)) {
    throw new Error(`${label} must be an array of documents`);
  }
  if (documents.length === 0) {
    throw new Error(`${label} must contain at least one document`);
  }
  const seen = new Set<string>();
  const validated: KnowledgeDocument[] = [];
  documents.forEach((entry, position) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${label}[${position}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error(`${label}[${position}].id must be a non-empty string`);
    }
    if (seen.has(id)) {
      throw new Error(
        `${label} contains two documents with id ${JSON.stringify(id)}; ` +
          `an answer quoted from one of them could not be attributed`
      );
    }
    seen.add(id);
    const text = record.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new Error(
        `${label}[${position}].text must be a non-empty string (id ${JSON.stringify(id)})`
      );
    }
    const title = record.title;
    if (title !== undefined && typeof title !== 'string') {
      throw new Error(
        `${label}[${position}].title must be a string when present`
      );
    }
    const tags = record.tags;
    if (tags !== undefined) {
      if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
        throw new Error(
          `${label}[${position}].tags must be an array of strings when present`
        );
      }
    }
    validated.push({
      id,
      ...(typeof title === 'string' ? { title } : {}),
      text,
      ...(Array.isArray(tags) ? { tags: tags as readonly string[] } : {}),
    });
  });
  return validated;
};

/** A corpus reduced to the term sets and idf weights every score needs. */
export interface DocumentIndex {
  documents: readonly KnowledgeDocument[];
  /** Term set per document, in corpus order. */
  termSets: ReadonlyArray<ReadonlySet<string>>;
  /** ln(1 + N/df) per term that appears anywhere in the corpus. */
  idf: ReadonlyMap<string, number>;
  /** The norm of each document's idf-weighted term set. */
  norms: readonly number[];
}

const weightedNorm = (
  terms: ReadonlySet<string>,
  idf: ReadonlyMap<string, number>
): number => {
  let total = 0;
  for (const term of terms) {
    const weight = idf.get(term) ?? 0;
    total += weight * weight;
  }
  return Math.sqrt(total);
};

export const buildIndex = (
  documents: readonly KnowledgeDocument[]
): DocumentIndex => {
  const tokenLists = documents.map((document) =>
    tokenize(`${document.title ?? ''} ${document.text}`)
  );
  const idf = inverseDocumentFrequency(tokenLists);
  const termSets = tokenLists.map((tokens) => new Set(tokens));
  return {
    documents,
    termSets,
    idf,
    norms: termSets.map((terms) => weightedNorm(terms, idf)),
  };
};

/** One document's score for one question, with the terms that produced it. */
export interface Match {
  id: string;
  title: string | null;
  score: number;
  matchedTerms: string[];
}

/**
 * Score every document against a question's terms. Documents that share no
 * term are left out rather than returned with a zero: a zero score is not a
 * weak answer, it is the absence of one, and returning it in a ranked list
 * invites a caller to read the top of the list as an answer.
 */
export const scoreQuery = (
  index: DocumentIndex,
  queryTerms: readonly string[]
): Match[] => {
  const questionSet = new Set(queryTerms);
  const questionNorm = weightedNorm(questionSet, index.idf);
  const matches: Match[] = [];
  index.documents.forEach((document, position) => {
    const terms = index.termSets[position];
    const matched: string[] = [];
    let dot = 0;
    for (const term of questionSet) {
      if (!terms.has(term)) continue;
      const weight = index.idf.get(term) ?? 0;
      dot += weight * weight;
      matched.push(term);
    }
    if (matched.length === 0) return;
    const denominator = questionNorm * index.norms[position];
    matches.push({
      id: document.id,
      title: document.title ?? null,
      score: denominator === 0 ? 0 : dot / denominator,
      matchedTerms: matched.sort(),
    });
  });
  matches.sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id)
  );
  return matches;
};

/**
 * The question terms no document in the corpus contains. This is the half a
 * caller cannot derive from a ranked list: a confident-looking top hit and a
 * question whose decisive word appears nowhere are the same list.
 */
export const absentTerms = (
  index: DocumentIndex,
  queryTerms: readonly string[]
): string[] =>
  [...new Set(queryTerms)].filter((term) => !index.idf.has(term)).sort();

/** A sentence quoted from a document, with where it came from. */
export interface Quotation {
  documentId: string;
  sentenceIndex: number;
  sentence: string;
  terms: string[];
}

/**
 * Every sentence of a document that contains at least one of the given terms,
 * in the document's own order. Order is preserved because a reordered set of
 * sentences reads as prose that the document does not contain.
 */
export const sentencesMentioning = (
  document: KnowledgeDocument,
  terms: readonly string[]
): Quotation[] => {
  const wanted = new Set(terms);
  const quotations: Quotation[] = [];
  splitSentences(document.text).forEach((sentence, sentenceIndex) => {
    const present = [...new Set(tokenize(sentence))]
      .filter((term) => wanted.has(term))
      .sort();
    if (present.length === 0) return;
    quotations.push({
      documentId: document.id,
      sentenceIndex,
      sentence,
      terms: present,
    });
  });
  return quotations;
};

/**
 * The rule `troubleshoot` uses to tell a description of a problem from a
 * description of what to do about it, published rather than described: a
 * sentence whose first content word is one of these verbs is treated as a
 * remedy. It is a shallow rule and the response says so by naming it, which is
 * what lets a caller judge the result instead of trusting it.
 */
export const REMEDY_VERBS: readonly string[] = Object.freeze([
  'add',
  'apply',
  'avoid',
  'check',
  'clear',
  'configure',
  'delete',
  'disable',
  'enable',
  'ensure',
  'increase',
  'install',
  'lower',
  'move',
  'raise',
  'reduce',
  'reinstall',
  'remove',
  'rerun',
  'reset',
  'restart',
  'retry',
  'run',
  'set',
  'start',
  'stop',
  'update',
  'upgrade',
  'use',
  'verify',
]);

/** The name of that rule, returned with every remedy so it can be judged. */
export const REMEDY_RULE = 'remedy-sentence-verb';

const REMEDY_VERB_SET = new Set(REMEDY_VERBS);

/** The sentences of a document that the published rule marks as remedies. */
export const remedySentences = (document: KnowledgeDocument): Quotation[] => {
  const quotations: Quotation[] = [];
  splitSentences(document.text).forEach((sentence, sentenceIndex) => {
    /*
     * The FIRST word of the sentence as written, not the first token that
     * survives `tokenize`: "the cache should restart" describes behaviour,
     * "restart the cache" instructs, and only the raw leading word separates
     * them.
     */
    const leading = /^[A-Za-z]+/.exec(sentence.trim());
    if (leading === null) return;
    const verb = leading[0].toLowerCase();
    if (!REMEDY_VERB_SET.has(verb)) return;
    quotations.push({
      documentId: document.id,
      sentenceIndex,
      sentence,
      terms: [verb],
    });
  });
  return quotations;
};

/**
 * Build the smallest value a JSON Schema node accepts.
 *
 * WHAT THIS REFUSES AND WHY: a `pattern` cannot be inverted -- there is no
 * general way to produce a string matching an arbitrary regex -- and a property
 * with no `type`, `enum`, `const` or branch gives nothing to construct from. In
 * both cases this throws, naming the path, rather than returning a value that
 * the schema would reject. An example that does not validate is worse than no
 * example, because the caller finds out at the point of use.
 *
 * The caller of this function validates the result against the same schema
 * before returning it, so a defect here surfaces as a reported violation rather
 * than as a plausible-looking example.
 */
export const exampleFromSchema = (
  node: JsonSchemaNode,
  path = '$'
): unknown => {
  if (node === null || typeof node !== 'object') {
    throw new Error(`${path} is not a schema object`);
  }
  if (node.const !== undefined) return node.const;
  if (Array.isArray(node.enum)) {
    if (node.enum.length === 0) {
      throw new Error(`${path} publishes an empty enum, which accepts nothing`);
    }
    return node.enum[0];
  }
  const branches = node.oneOf ?? node.anyOf;
  if (Array.isArray(branches) && branches.length > 0) {
    /*
     * The first branch, merged with the siblings beside the keyword. The merge
     * is per property rather than wholesale: a conditional-requirement branch
     * publishes `required` plus a `const` that pins one discriminator, and the
     * definitions of everything it requires live in the parent's `properties`.
     * Replacing the parent's property map with the branch's one-entry map left
     * every such requirement undefined, and eight of this package's own tools
     * refused with "requires X but publishes no definition for it" -- a
     * refusal that named a real published definition.
     */
    const { oneOf: _oneOf, anyOf: _anyOf, ...rest } = node;
    const branch = branches[0];
    return exampleFromSchema(
      {
        ...rest,
        ...branch,
        properties: {
          ...(rest.properties ?? {}),
          ...(branch.properties ?? {}),
        },
        required: [
          ...new Set([...(rest.required ?? []), ...(branch.required ?? [])]),
        ],
      },
      `${path}/branch[0]`
    );
  }

  const declared = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (declared) {
    case 'object':
      return exampleObject(node, path);
    case 'array':
      return exampleArray(node, path);
    case 'string':
      return exampleString(node, path);
    case 'number':
    case 'integer':
      return exampleNumber(node, declared === 'integer', path);
    case 'boolean':
      return typeof node.default === 'boolean' ? node.default : true;
    case 'null':
      return null;
    default:
      throw new Error(
        `${path} declares no type, enum, const or branch, so there is nothing ` +
          `to build an example from`
      );
  }
};

const exampleObject = (node: JsonSchemaNode, path: string): unknown => {
  const properties = node.properties ?? {};
  const required = node.required ?? [];
  const value: Record<string, unknown> = {};
  for (const key of required) {
    const definition = properties[key];
    if (definition === undefined) {
      throw new Error(
        `${path} requires ${JSON.stringify(key)} but publishes no definition ` +
          `for it, so no value can be built`
      );
    }
    value[key] = exampleFromSchema(definition, `${path}.${key}`);
  }
  return value;
};

const exampleArray = (node: JsonSchemaNode, path: string): unknown => {
  const least = node.minItems ?? 0;
  if (node.items === undefined) {
    if (least > 0) {
      throw new Error(
        `${path} requires ${least} item(s) but publishes no item schema`
      );
    }
    return [];
  }
  const count = Math.max(least, 1);
  const most = node.maxItems;
  if (most !== undefined && most < least) {
    throw new Error(
      `${path} publishes maxItems ${most} below minItems ${least}, which ` +
        `accepts no array`
    );
  }
  const wanted = most === undefined ? count : Math.min(count, most);
  const item = exampleFromSchema(node.items, `${path}[0]`);
  return Array.from({ length: wanted }, () =>
    typeof item === 'object' && item !== null
      ? (JSON.parse(JSON.stringify(item)) as unknown)
      : item
  );
};

/** The filler an unconstrained string example uses. */
export const EXAMPLE_STRING = 'example';

const exampleString = (node: JsonSchemaNode, path: string): unknown => {
  if (typeof node.default === 'string') return node.default;
  if (node.format === 'date') return '2026-01-01';
  if (node.format === 'date-time') return '2026-01-01T00:00:00Z';
  if (typeof node.pattern === 'string') {
    throw new Error(
      `${path} publishes pattern ${JSON.stringify(node.pattern)}; a string ` +
        `matching an arbitrary pattern cannot be constructed, so no example ` +
        `is offered rather than one the schema would reject`
    );
  }
  const least = node.minLength ?? 0;
  const most = node.maxLength;
  if (most !== undefined && most < least) {
    throw new Error(
      `${path} publishes maxLength ${most} below minLength ${least}, which ` +
        `accepts no string`
    );
  }
  let built = EXAMPLE_STRING;
  if (built.length < least) built = built.padEnd(least, 'x');
  if (most !== undefined && built.length > most) built = built.slice(0, most);
  if (built.length < least) {
    throw new Error(`${path} cannot be satisfied: no string fits its bounds`);
  }
  return built;
};

const exampleNumber = (
  node: JsonSchemaNode,
  integral: boolean,
  path: string
): unknown => {
  if (typeof node.default === 'number') return node.default;
  const lowest =
    node.minimum ??
    (node.exclusiveMinimum === undefined
      ? undefined
      : node.exclusiveMinimum + 1);
  const highest =
    node.maximum ??
    (node.exclusiveMaximum === undefined
      ? undefined
      : node.exclusiveMaximum - 1);
  let built: number;
  if (lowest !== undefined) built = integral ? Math.ceil(lowest) : lowest;
  else if (highest !== undefined) built = Math.min(0, highest);
  else built = 0;
  if (highest !== undefined && built > highest) {
    throw new Error(
      `${path} publishes bounds that accept no ${integral ? 'integer' : 'number'}`
    );
  }
  return built;
};
