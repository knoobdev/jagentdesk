const STYLE_ID = "jagentdesk-web-placeholder-styles";

/**
 * react-native-web paints `::placeholder` with `var(--placeholderTextColor)`, which it sets
 * only when a TextInput passes `placeholderTextColor`. Without it the variable is undefined
 * and the placeholder inherits the text colour, so it renders as typed text. Defaulting the
 * variable on the root to the theme's muted foreground (a Unistyles theme variable) gives
 * every input the spec 38 §2.1 placeholder colour; an explicit prop still wins.
 */
export function installWebPlaceholderStyles(): () => void {
  if (document.getElementById(STYLE_ID)) return () => {};
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
:root {
  --placeholderTextColor: var(--colors-foreground-muted);
}
input::placeholder,
textarea::placeholder {
  color: var(--placeholderTextColor);
  opacity: 1;
}
`;
  document.head.append(style);
  return () => style.remove();
}
