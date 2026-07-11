// Tree-sitter tag queries for TypeScript/TSX. Adapted from aider's
// MIT-licensed tag queries (aider/queries/tree-sitter-typescript-tags.scm)
// to extract definition and reference nodes for the repo map.
// `name.definition.X` captures are extracted as defs;
// `name.reference.X` captures are extracted as refs.

const SHARED_TS = String.raw`
(function_signature
  name: (identifier) @name.definition.function) @definition.function

(method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_method_signature
  name: (property_identifier) @name.definition.method) @definition.method

(abstract_class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(module
  name: (identifier) @name.definition.module) @definition.module

(interface_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

(type_alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.variable
    value: (arrow_function))) @definition.function

(call_expression
  function: (identifier) @name.reference.call)

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call))

(new_expression
  constructor: (identifier) @name.reference.class)

(type_annotation
  (type_identifier) @name.reference.type)
`;

export const TYPESCRIPT_QUERY = SHARED_TS;
export const TSX_QUERY = SHARED_TS;
