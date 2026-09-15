export type CredentialName = string;

export interface SecretLease {
  withValue<T>(use: (value: string) => T): T;
  dispose(): void;
}

export interface SecretProvider {
  getForUse(name: CredentialName): Promise<SecretLease>;
}
