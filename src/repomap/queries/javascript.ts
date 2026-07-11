// Tree-sitter tag queries for JavaScript. Adapted from aider's MIT-licensed
// tag queries (aider/queries/tree-sitter-javascript-tags.scm).

export const JAVASCRIPT_QUERY = String.raw`
(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(class_declaration
  name: (identifier) @name.definition.class) @definition.class

(lexical_declaration
  (variable_declarator
    name: (identifier) @name.definition.variable
    value: (arrow_function))) @definition.function

(variable_declaration
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
`;
