import { expect, it } from "vitest";
import { PRODUCTION_MENU_ROLES, applicationMenuTemplate } from "./app-menu.js";

const roles = (packaged: boolean) => applicationMenuTemplate(packaged).map(item => item.role);

it("exposes no reload or DevTools entry to a packaged window", () => {
  expect(roles(true)).toEqual([...PRODUCTION_MENU_ROLES]);
  const serialized = JSON.stringify(applicationMenuTemplate(true));
  for (const role of ["reload", "forceReload", "toggleDevTools", "viewMenu"]) expect(serialized).not.toContain(role);
});

it("keeps clipboard roles and adds the development view menu", () => {
  expect(roles(false)).toEqual(["appMenu", "editMenu", "viewMenu", "windowMenu"]);
  expect(roles(true)).toContain("editMenu");
  expect(applicationMenuTemplate(false).every(item => typeof item.role === "string")).toBe(true);
});
