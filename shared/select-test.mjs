export async function chooseOption(control, value) {
  if (await control.evaluate(node => node.tagName === 'SELECT')) return control.selectOption(value);
  await control.click();
  await control.page().locator(`[data-slot="select-item"][data-value=${JSON.stringify(value)}]`).click();
}
