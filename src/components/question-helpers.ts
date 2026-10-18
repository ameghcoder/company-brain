// A clarified name replaces the ambiguous word it resolves ("Alex" -> "Alex Chen").
export function withName(question: string, name: string): string {
  if (question.includes(name)) return question;
  const first = (name.split(" ")[0] ?? name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${first}\\b`);
  return pattern.test(question) ? question.replace(pattern, name) : `${question} (${name})`;
}
