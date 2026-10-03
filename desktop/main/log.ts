/**
 * Size-capped file logs under %APPDATA%\Aharos\logs. When a log passes the cap it
 * is renamed to *.1 (one generation kept). Never given secrets or passwords.
 */
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;

function appender(file: string) {
  return (line: string) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, line.endsWith("\n") ? line : `${line}\n`);
    } catch {
      /* logging must never take the app down */
    }
  };
}

export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  server(chunk: string): void;
};

export function createLogger(dir: string, echo = false): Logger {
  fs.mkdirSync(dir, { recursive: true });
  const main = appender(path.join(dir, "main.log"));
  const server = appender(path.join(dir, "server.log"));
  const line = (level: string, msg: string) => {
    const l = `${new Date().toISOString()} ${level} ${msg}`;
    main(l);
    if (echo) console.log(l);
  };
  return {
    info: (m) => line("INFO", m),
    warn: (m) => line("WARN", m),
    error: (m) => line("ERROR", m),
    server: (chunk) => server(chunk.trimEnd()),
  };
}
