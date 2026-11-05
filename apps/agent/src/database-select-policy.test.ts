import { describe, expect, it } from 'vitest';
import { assertReadOnlySelect } from './database-select-policy.js';

const accepted = [
  'SELECT 1',
  'SELECT ? AS value',
  'SELECT CAST(9007199254740993 AS SIGNED) AS exact_value',
  "SELECT CAST(9007199254740993 AS SIGNED) AS exact_value, CAST(1234567890.123456789 AS DECIMAL(30,9)) AS amount, CAST('abc' AS BINARY) AS bytes",
  'SELECT 1 AS `INTO`, COUNT(*) AS `SLEEP` FROM users',
  'WITH sleep AS (SELECT 1 AS id) SELECT id FROM sleep',
  'SELECT id, name FROM users WHERE id = ? ORDER BY id LIMIT 10',
  'SELECT 1 AS duplicate_name, 2 AS duplicate_name;',
  "SELECT 'DROP TABLE users; -- # /* */' AS text",
  "SELECT 'it''s safe' AS text, `update` FROM `orders`",
  "SELECT 'escaped\\'quote' AS text",
  'SELECT COUNT(*), SUM(amount), AVG(amount), MIN(amount), MAX(amount) FROM orders',
  "SELECT COALESCE(name, 'unknown'), IFNULL(name, ''), NULLIF(id, 0), IF(id > 0, 1, 0) FROM users",
  'SELECT CAST(id AS CHAR), CONVERT(id, CHAR), ABS(id), ROUND(amount, 2), CEIL(amount), FLOOR(amount) FROM orders',
  "SELECT CONCAT(name, 'x'), LOWER(name), UPPER(name), TRIM(name), LENGTH(name), CHAR_LENGTH(name), SUBSTRING(name, 1, 2), REPLACE(name, 'a', 'b') FROM users",
  'SELECT DATE(created_at), YEAR(created_at), MONTH(created_at), DAY(created_at), NOW(), CURRENT_DATE() FROM users',
  'SELECT ROW_NUMBER() OVER (ORDER BY id), RANK() OVER (ORDER BY id), DENSE_RANK() OVER (ORDER BY id) FROM users',
  'SELECT u.id FROM users AS u JOIN orders AS o ON u.id = o.user_id WHERE u.id IN (1, 2) AND o.total >= 0',
  'SELECT id FROM users WHERE EXISTS (SELECT 1 FROM orders WHERE user_id = users.id)',
  'WITH active AS (SELECT id FROM users WHERE enabled = 1) SELECT id FROM active',
  'WITH active(id) AS (SELECT id FROM users) SELECT id FROM active',
  'WITH RECURSIVE n AS (SELECT 1 AS value UNION ALL SELECT value + 1 FROM n WHERE value < 3) SELECT value FROM n',
  'SELECT id FROM users UNION ALL SELECT id FROM archived_users',
  'SELECT (SELECT MAX(id) FROM users) AS max_id',
  'SELECT CASE WHEN id > 0 THEN 1 ELSE 0 END FROM users',
];
const denied = [
  '', ' ', 'DELETE FROM users', 'UPDATE users SET name = 1', 'INSERT INTO users VALUES (1)',
  'REPLACE INTO users VALUES (1)', 'SELECT 1; SELECT 2', 'SELECT 1;;', 'SELECT 1; DELETE FROM users',
  "SELECT 1 INTO OUTFILE '/tmp/result'", "SELECT 1 INTO DUMPFILE '/tmp/result'", 'SELECT id INTO @result FROM users',
  'SELECT * FROM users FOR UPDATE', 'SELECT * FROM users FOR SHARE', 'SELECT * FROM users LOCK IN SHARE MODE',
  'SELECT * FROM users PROCEDURE ANALYSE()',
  'SELECT @x', 'SELECT @@version', 'SELECT @x := 1',
  "SELECT LOAD_FILE('/etc/passwd')", 'SELECT SLEEP(1)', 'SELECT BENCHMARK(100, 1)',
  "SELECT GET_LOCK('name', 1)", "SELECT RELEASE_LOCK('name')", 'SELECT RELEASE_ALL_LOCKS()',
  'SELECT \u0131FNULL(1, 2)', 'SELECT \u017fUM(1)', 'SELECT \u017fUBSTRING(1, 1, 1)',
  'SELECT arbitrary_udf(1)', 'SELECT app.fn(1)', 'SELECT mysql.SLEEP(1)', 'SELECT `SLEEP`(1)',
  'SELECT `app`.`fn`(1)', 'SELECT `COUNT`(1)',
  "SELECT * FROM other_schema.users", 'SELECT other_schema.users.id FROM other_schema.users',
  'WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x',
  'WITH x AS (SELECT 1) DELETE FROM users',
  'SELECT (SELECT SLEEP(1))',
  'SELECT CAST(9007199254740993 AS SIGNED), SLEEP(1)',
  'SELECT 1 UNION ALL SELECT SLEEP(1)',
  "WITH x AS (SELECT LOAD_FILE('/etc/passwd')) SELECT * FROM x",
  'SELECT JSON_EXTRACT(value, \'$.name\') FROM users',
  'SELECT EXTRACT(YEAR FROM created_at) FROM users',
  'SELECT 1 /* comment */', "SELECT 1 /*!50000 INTO OUTFILE '/tmp/out' */",
  "SELECT 1 /*M!100000 INTO OUTFILE '/tmp/out' */", 'SELECT /*+ MAX_EXECUTION_TIME(999999) */ 1',
  'SELECT 1 -- comment', 'SELECT 1 # comment',
  "SELECT 'unterminated", 'SELECT `unterminated',
  'SELECT \u0000',
];

describe('MySQL/MariaDB read-only SELECT policy', () => {
  it.each(accepted)('accepts supported SELECT: %s', sql => {
    expect(() => assertReadOnlySelect(sql)).not.toThrow();
  });
  it.each(denied)('denies unsupported or unsafe statement: %s', sql => {
    expect(() => assertReadOnlySelect(sql)).toThrow('Database SELECT denied');
  });
  it('rejects UTF-8 byte overflow before parsing', () => {
    expect(() => assertReadOnlySelect("SELECT '" + '\uD55C'.repeat(6000) + "'")).toThrow('Database SELECT denied');
  });
  it('rejects excessive parentheses and never includes SQL in the error', () => {
    const sql = 'SELECT ' + '('.repeat(65) + '1' + ')'.repeat(65);
    expect(() => assertReadOnlySelect(sql)).toThrow('Database SELECT denied');
    try { assertReadOnlySelect("SELECT LOAD_FILE('private-credential')"); }
    catch (error) { expect(String(error)).not.toContain('private-credential'); }
  });
  it('rejects excessive AST width and depth within the lexical byte bound', () => {
    expect(() => assertReadOnlySelect('SELECT ' + Array(4200).fill('1').join(','))).toThrow('Database SELECT denied');
    const expression = 'CASE WHEN 1 THEN '.repeat(130) + '1' + ' ELSE 0 END'.repeat(130);
    expect(() => assertReadOnlySelect('SELECT ' + expression)).toThrow('Database SELECT denied');
  });
  it('does not count parentheses or comment markers inside quoted values', () => {
    expect(() => assertReadOnlySelect("SELECT '" + '('.repeat(100) + " -- # /*' AS value")).not.toThrow();
  });
});
