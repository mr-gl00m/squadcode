// Tree-sitter tag queries for Python. Adapted from aider's MIT-licensed
// tag queries (aider/queries/tree-sitter-python-tags.scm).

export const PYTHON_QUERY = String.raw`
(function_definition
  name: (identifier) @name.definition.function) @definition.function

(class_definition
  name: (identifier) @name.definition.class) @definition.class

(call
  function: (identifier) @name.reference.call)

(call
  function: (attribute
    attribute: (identifier) @name.reference.call))
`;
