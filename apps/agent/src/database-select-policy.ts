import sqlParser from 'node-sql-parser';

const parser = new sqlParser.Parser();
const safeFunctions = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'IFNULL', 'NULLIF', 'IF',
  'CAST', 'CONVERT', 'ABS', 'ROUND', 'CEIL', 'FLOOR', 'CONCAT', 'LOWER', 'UPPER',
  'TRIM', 'LENGTH', 'CHAR_LENGTH', 'SUBSTRING', 'REPLACE', 'DATE', 'YEAR', 'MONTH',
  'DAY', 'NOW', 'CURRENT_DATE', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'EXISTS',
]);
const safeTypes = new Set([
  'select', 'column_ref', 'number', 'bigint', 'single_quote_string', 'double_quote_string',
  'backticks_quote_string', 'string', 'bool', 'null', 'star', 'origin', 'default',
  'expr_list', 'binary_expr', 'unary_expr', 'aggr_func', 'function', 'cast',
  'datatype', 'case', 'when', 'else', 'window', 'ASC', 'DESC',
]);
const safeOperators = new Set([
  '=', '>', '<', '>=', '<=', '<>', '!=', '<=>', '+', '-', '*', '/', '%', 'DIV',
  'MOD', 'AND', 'OR', 'XOR', 'NOT', '!', '~', '|', '&', '^', '<<', '>>', '||',
  '&&', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'IS', 'IS NOT', 'BETWEEN',
  'NOT BETWEEN', 'REGEXP', 'NOT REGEXP', 'EXISTS', 'NOT EXISTS',
]);
const forbiddenWords = new Set([
  'INTO', 'PROCEDURE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER',
  'DROP', 'TRUNCATE', 'LOAD', 'CALL', 'SET', 'DO', 'HANDLER', 'LOCK', 'UNLOCK',
  'GRANT', 'REVOKE', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'COMMIT', 'ROLLBACK',
]);
function deny(): never { throw new Error('Database SELECT denied'); }

// Requires the pinned non-ANSI, backslash-escape, IGNORE_SPACE session mode.
function lexicalCheck(sql: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0 ||
      Buffer.byteLength(sql, 'utf8') > 16384 || sql.includes('\0')) deny();
  let quote = '';
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (quote) {
      if (char === '\\' && quote !== '`') { if (++i === sql.length) deny(); }
      else if (char === '\\' && quote === '`') deny();
      else if (char === quote) {
        if (sql[i + 1] === quote) i++;
        else quote = '';
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char;continue; }
    if ((char === '/' && sql[i + 1] === '*') || (char === '-' && sql[i + 1] === '-') ||
        char === '#' || char === '@' || (char === ':' && sql[i + 1] === '=')) deny();
    if (char === ';' && sql.slice(i + 1).trim() !== '') deny();
    if (char === '(' && ++depth > 64) deny();
    if (char === ')' && --depth < 0) deny();
    if (/[A-Za-z_]/u.test(char ?? '')) {
      const start = i;
      while (/[A-Za-z0-9_$]/u.test(sql[i + 1] ?? '')) i++;
      if (forbiddenWords.has(sql.slice(start, i + 1).toUpperCase())) deny();
    }
  }
  if (quote || depth !== 0) deny();
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function checkFunction(node: Record<string, unknown>): void {
  if (node.type === 'aggr_func') {
    if (typeof node.name !== 'string' || !/^[A-Za-z_]+$/u.test(node.name) ||
        !safeFunctions.has(node.name.toUpperCase())) deny();
    return;
  }
  if (!record(node.name) || Object.keys(node.name).some(key => key !== 'name') ||
      !Array.isArray(node.name.name) || node.name.name.length !== 1) deny();
  const name: unknown = node.name.name[0];
  if (!record(name) || !['default', 'origin'].includes(String(name.type)) ||
      typeof name.value !== 'string' || !/^[A-Za-z_]+$/u.test(name.value) ||
      !safeFunctions.has(name.value.toUpperCase())) deny();
}
function checkTree(root: Record<string, unknown>): void {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || ++nodes > 20000 || current.depth > 128) deny();
    const value = current.value;
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!record(value)) continue;
    if (typeof value.type === 'string' && !safeTypes.has(value.type)) deny();
    if (value.db != null || value.schema != null) deny();
    if (typeof value.operator === 'string' && !safeOperators.has(value.operator.toUpperCase())) deny();
    if (value.type === 'function' || value.type === 'aggr_func') checkFunction(value);
    if (value.type === 'select') {
      if (value.locking_read != null || value.procedure != null || value.options != null) deny();
      if (value.into != null && (!record(value.into) ||
          Object.entries(value.into).some(([key, item]) => key !== 'position' || item != null))) deny();
      if (value.set_op != null && !['union', 'union all'].includes(String(value.set_op).toLowerCase())) deny();
    }
    for (const item of Object.values(value)) stack.push({ value: item, depth: current.depth + 1 });
  }
}

export function assertReadOnlySelect(sql: string): void {
  try {
    lexicalCheck(sql);
    const parsed: unknown = parser.astify(sql, { database: 'MySQL' });
    const statements = Array.isArray(parsed) ? parsed : [parsed];
    if (statements.length !== 1 || !record(statements[0]) || statements[0].type !== 'select') deny();
    checkTree(statements[0]);
  } catch { deny(); }
}
