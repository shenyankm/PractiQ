import type { MenuItemConstructorOptions } from "electron";

/**
 * The packaged app keeps only the macOS application, edit and window roles so that clipboard
 * and window shortcuts keep working. Development additionally keeps reload and DevTools.
 */
export function applicationMenuTemplate(packaged: boolean): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [{ role: "appMenu" }, { role: "editMenu" }];
  if (!packaged) template.push({ role: "viewMenu" });
  template.push({ role: "windowMenu" });
  return template;
}

export const PRODUCTION_MENU_ROLES = ["appMenu", "editMenu", "windowMenu"] as const;
