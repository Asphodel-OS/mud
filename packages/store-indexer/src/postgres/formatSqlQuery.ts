import sqlParser from "node-sql-parser";

type AstNode = {
  type?: string;
  [key: string]: unknown;
};

export function formatSqlQuery(sqlQuery: string): string {
  const parser = new sqlParser.Parser();
  const ast = parser.astify(sqlQuery);
  updateNode(ast);
  return parser.sqlify(ast, { database: "postgresql" });
}

function updateNode(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach((item) => updateNode(item));
    return;
  }

  if (node && typeof node === "object") {
    const astNode = node as AstNode;
    if (
      astNode.type === "column_ref" &&
      typeof astNode.column === "string" &&
      /^[a-z]+[A-Z][a-z]*$/.test(astNode.column)
    ) {
      astNode.column = camelToSnakeCase(astNode.column);
    }
    for (const [, value] of Object.entries(astNode)) {
      if (typeof value === "object" && value !== null) {
        updateNode(value);
      }
    }
  }
}

function camelToSnakeCase(str: string): string {
  return str.replace(/([a-z]+)([A-Z][a-z]*)/g, "$1_$2").toLowerCase();
}
