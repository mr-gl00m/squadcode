// Tree-sitter tag queries for Rust. Adapted from aider's MIT-licensed
// tag queries (aider/queries/tree-sitter-rust-tags.scm).

export const RUST_QUERY = String.raw`
(function_item
  name: (identifier) @name.definition.function) @definition.function

(function_signature_item
  name: (identifier) @name.definition.function) @definition.function

(struct_item
  name: (type_identifier) @name.definition.class) @definition.class

(enum_item
  name: (type_identifier) @name.definition.class) @definition.class

(trait_item
  name: (type_identifier) @name.definition.interface) @definition.interface

(mod_item
  name: (identifier) @name.definition.module) @definition.module

(impl_item
  trait: (type_identifier) @name.reference.interface)

(impl_item
  type: (type_identifier) @name.reference.class)

(call_expression
  function: (identifier) @name.reference.call)

(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call))

(call_expression
  function: (scoped_identifier
    name: (identifier) @name.reference.call))
`;
