/** @file Barrel for the grammar feature's shared validation schemas and wire DTOs (feature 042). */

export {
  DICTIONARY_TERM_MAX_LEN,
  IGNORED_LINTS_BLOB_MAX_LEN,
  dictionaryTermSchema,
  grammarDialectSchema,
  addDictionaryTermSchema,
  ignoredLintsBlobSchema,
  type GrammarDialect,
} from './grammar-config';

export type {
  DictionaryTermDto,
  DictionaryListDto,
  IgnoredLintsDto,
} from './grammar.dto';
