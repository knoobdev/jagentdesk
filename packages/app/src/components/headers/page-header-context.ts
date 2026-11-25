import { createContext } from "react";

/**
 * True inside a page header's action slot. Buttons there render at the header-action height
 * (36 px in the Gumloop shell) so every page's History / New agent / All bots row matches.
 */
export const PageHeaderActionContext = createContext(false);
