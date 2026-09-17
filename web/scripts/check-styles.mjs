import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const numbers = '(?:0|0\\.5|1|1\\.5|2|2\\.5|3|3\\.5|4|5|6|7|8|9|10|11|12|14|16|20|24|28|32|36|40|44|48|52|56|60|64|72|80|96)';
const layout = new RegExp(`^(?:(?:sm|md|lg|xl|2xl):)*(?:(?:block|inline-block|flex|inline-flex|grid|hidden|relative|absolute|fixed|sticky|static)|(?:flex-(?:row|col|wrap|nowrap|1|auto|none))|(?:items-(?:start|end|center|baseline|stretch))|(?:justify-(?:start|end|center|between|around|evenly))|(?:self-(?:start|end|center|stretch))|(?:(?:shrink|grow)(?:-0)?)|(?:(?:grid-cols|col-span|row-span)-[1-9])|(?:gap(?:-[xy])?-${numbers})|(?:[mp][xytrbl]?-(?:${numbers}|auto))|(?:(?:min-|max-)?[wh]-(?:${numbers}|full|screen|dvh|svh|auto|none|xs|sm|md|lg|xl|[2-7]xl))|(?:(?:inset(?:-[xy])?|top|bottom|left|right)-0)|(?:z-(?:0|10|20|30|40|50))|(?:overflow(?:-[xy])?-(?:auto|hidden|scroll|visible)))$`);
export function checkSource(source, file = 'example.tsx') {
  const errors = [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(tree);
      if (['style', 'css', 'classNames', 'tw'].includes(name)) errors.push(`禁止 ${name} 属性`);
      if (name === 'className') {
        if (!node.initializer || !ts.isStringLiteral(node.initializer)) errors.push('className 必须是可审查的静态布局工具类');
        else for (const token of node.initializer.text.split(/\s+/).filter(Boolean)) if (!layout.test(token)) errors.push(`禁止非标准布局工具类：${token}`);
      }
    }
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ['style', 'button', 'select', 'textarea'].includes(node.tagName.getText(tree))) errors.push('使用 HeroUI 控件，禁止自建样式或原生同类控件');
    if (ts.isImportDeclaration(node)) {
      const name = node.moduleSpecifier.text;
      if (/styled|emotion|\.module\.|\.s[ac]ss|\.less/.test(name)) errors.push(`禁止样式导入：${name}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (/\.style\b|setAttribute\s*\(\s*['"](?:style|class)|insertRule|createGlobalStyle|dangerouslySetInnerHTML|classList\./.test(source)) errors.push('禁止动态样式或原始 HTML 注入');
  return errors;
}
export function checkDirectory(root) {
  const errors = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      const source = fs.readFileSync(file, 'utf8');
      if (/\.(css|scss|sass|less)$/.test(file)) {
        if (path.relative(root, file) !== 'styles.css' || source.trim() !== '@import "tailwindcss";\n@import "@heroui/styles";') errors.push(`${file}: 仅允许官方样式导入`);
      } else if (/\.[jt]sx?$/.test(file)) {
        errors.push(...checkSource(source, file).map(message => `${file}: ${message}`));
      }
    }
  }
  walk(root);
  return errors;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkDirectory(fileURLToPath(new URL('../src', import.meta.url)));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('HeroUI defaults + standard layout utilities only: OK');
}
