/**
 * Split a Prisma-generated SQLite migration into single statements.
 *
 * Needed because Prisma's raw SQL on SQLite executes ONLY the first statement of
 * a multi-statement string and still reports success. The splitter understands
 * '…' and "…" literals (with doubled-quote escapes), `…` and […] identifiers,
 * -- and /* *\/ comments. It refuses SQL whose statements can contain `;` in a
 * way it cannot split safely (CREATE TRIGGER … BEGIN … END), instead of guessing.
 */
export class UnsafeMigrationSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeMigrationSqlError";
  }
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const n = sql.length;

  const push = () => {
    const s = current.trim();
    if (s) statements.push(s);
    current = "";
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      current += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new UnsafeMigrationSqlError("Unterminated /* comment */ in migration SQL");
      i = end + 2;
      current += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new UnsafeMigrationSqlError(`Unterminated ${c} literal in migration SQL`);
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) {
            j += 2; // doubled quote = escaped quote
            continue;
          }
          break;
        }
        j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === ";") {
      push();
      i++;
      continue;
    }
    current += c;
    i++;
  }
  push();

  for (const s of statements) {
    if (/^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(s)) {
      throw new UnsafeMigrationSqlError("CREATE TRIGGER is not supported by the desktop migrator (statement bodies contain ';')");
    }
  }
  return statements;
}
