import { SecretRedactor } from '@gram/secrets';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;

export interface StructuredLoggerOptions {
  redactor: SecretRedactor;
  sink?: LogSink;
  now?: () => Date;
}

export class StructuredLogger {
  private readonly sink: LogSink;
  private readonly now: () => Date;

  constructor(private readonly options: StructuredLoggerOptions) {
    this.sink = options.sink ?? ((line) => console.log(line));
    this.now = options.now ?? (() => new Date());
  }

  debug(message: string, metadata: Record<string, unknown> = {}): void {
    this.write('debug', message, metadata);
  }

  info(message: string, metadata: Record<string, unknown> = {}): void {
    this.write('info', message, metadata);
  }

  warn(message: string, metadata: Record<string, unknown> = {}): void {
    this.write('warn', message, metadata);
  }

  error(message: string, metadata: Record<string, unknown> = {}): void {
    this.write('error', message, metadata);
  }

  private write(level: LogLevel, message: string, metadata: Record<string, unknown>): void {
    const record = {
      timestamp: this.now().toISOString(),
      level,
      message: this.options.redactor.redact(message),
      metadata: this.options.redactor.redactValue(metadata),
    };
    this.sink(JSON.stringify(record));
  }
}
