export function redactEvidenceText(input: string, token: string): string {
  let output = input;
  if (token) output = output.split(token).join('[REDACTED_TOKEN]');
  output = output.replace(
    /\b(?:x-internal-token|authorization|token|secret|password|api[_-]?key)=([^&\s]+)/gi,
    (_match, value: string) => `[REDACTED_FIELD]=${value ? '[REDACTED_SECRET]' : ''}`,
  );
  return output;
}
