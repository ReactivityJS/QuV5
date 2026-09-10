/**
 * SCHEMA — the standard `prosemirror-schema-basic` node/mark set (paragraph,
 * blockquote, heading, code_block, hard_break; marks: strong, em, link,
 * code) plus `prosemirror-schema-list`'s list nodes (bullet_list,
 * ordered_list, list_item) - the same well-exercised combination virtually
 * every ProseMirror app starts from (including `prosemirror-example-setup`),
 * not a bespoke schema invented for this package. Deliberately not the
 * WHOLE `prosemirror-schema-basic` node set exposed via toolbar buttons -
 * `toolbar.js`'s own doc comment on which of these are actually reachable
 * (Bold/Italic/Link/H2/bullet-list, feature parity with the OLD `@qu/space-ui`
 * `bindRichText()` this package replaces) - the rest (blockquote, code_block,
 * ordered lists, ...) still work via the schema/keymap, just without a
 * dedicated button yet.
 */
import { Schema } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';

export const richTextSchema = new Schema({
  nodes: addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block'),
  marks: basicSchema.spec.marks,
});
