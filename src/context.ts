export interface BoundedText {
  text: string;
  truncated: boolean;
  originalLength: number;
}

export function boundText(text: string, maxCharacters: number): BoundedText {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
    throw new RangeError("maxCharacters must be a positive safe integer");
  }

  return {
    text: text.slice(0, maxCharacters),
    truncated: text.length > maxCharacters,
    originalLength: text.length,
  };
}
