// Marks user-facing English text for translation: JSX text, a few attributes,
// strings/templates rendered from JSX expressions, and toast()/setNote() messages.
// Edits are spliced by source offsets so the rest of the code keeps its formatting.
const fs = require('fs');
const { parse } = require('@babel/parser');

const ATTRS = new Set(['aria-label', 'placeholder', 'title', 'alt']);
const MSG_FUNCS = new Set(['toast', 'setNote']);
const latin = (s) => /[A-Za-z]{2,}/.test(s);

function walk(node, parent, fn, ctx) {
  if (!node || typeof node.type !== 'string') return;
  const next = fn(node, parent, ctx) || ctx;
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, node, fn, next));
    else if (v && typeof v.type === 'string') walk(v, node, fn, next);
  }
}

function templateToCall(src, node) {
  // `a ${x} b` -> t("a {0} b", { 0: x })
  let key = '', vars = [];
  node.quasis.forEach((q, i) => {
    key += q.value.cooked;
    if (i < node.expressions.length) { key += `{${i}}`; vars.push(src.slice(node.expressions[i].start, node.expressions[i].end)); }
  });
  const v = vars.length ? `, { ${vars.map((e, i) => `${i}: ${e}`).join(', ')} }` : '';
  return `t(${JSON.stringify(key)}${v})`;
}

function processFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = parse(src, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const edits = [];
  const add = (start, end, text) => edits.push({ start, end, text });

  walk(ast.program, null, (node, parent, ctx) => {
    // Do not touch the paper documents' own (Hebrew) content or calls already wrapped
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && (node.callee.name === 't' || node.callee.name === 'plural')) return { skip: true };
    if (ctx && ctx.skip) return ctx;

    if (node.type === 'JSXText') {
      const raw = src.slice(node.start, node.end);
      if (!latin(raw)) return;
      const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
      const text = raw.trim().replace(/\s+/g, ' ');
      const decoded = text.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
      add(node.start, node.end, `${lead}{t(${JSON.stringify(decoded)})}${trail}`);
      return;
    }
    if (node.type === 'JSXAttribute' && node.name && ATTRS.has(node.name.name) && node.value) {
      if (node.value.type === 'StringLiteral' && latin(node.value.value)) add(node.value.start, node.value.end, `{t(${JSON.stringify(node.value.value)})}`);
      else if (node.value.type === 'JSXExpressionContainer' && node.value.expression.type === 'TemplateLiteral' && latin(node.value.expression.quasis.map((q) => q.value.cooked).join(''))) {
        const e = node.value.expression; add(e.start, e.end, templateToCall(src, e));
      }
      return { skip: true };
    }
    if (node.type === 'JSXAttribute') return { skip: true };           // className, key, type, id… stay as they are
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') return { reset: true };   // markup starts a fresh context
    if (node.type === 'JSXExpressionContainer') return { inJsx: true };
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && MSG_FUNCS.has(node.callee.name)) return { msg: true };

    const rendered = ctx && !ctx.reset && (ctx.inJsx || ctx.msg);
    if (!rendered) return;
    // Only strings that end up on screen: direct children, branches of ?: and the right side of && / ||
    const isBranch = parent && ((parent.type === 'ConditionalExpression' && (parent.consequent === node || parent.alternate === node))
      || (parent.type === 'LogicalExpression' && parent.right === node)
      || parent.type === 'JSXExpressionContainer'
      || (parent.type === 'CallExpression' && MSG_FUNCS.has(parent.callee && parent.callee.name) && parent.arguments[0] === node)
      || (parent.type === 'BinaryExpression' && parent.operator === '+' && ctx.msg));
    if (!isBranch) {
      // Strings inside other expressions (comparisons, function args) are logic, not text
      if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') return { skip: true };
      if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression' || (node.type === 'BinaryExpression' && ctx.msg)) return;
      return { reset: true };   // e.g. an arrow function in .map(): its own markup is handled, its strings are not text
    }
    if (node.type === 'StringLiteral' && latin(node.value)) { add(node.start, node.end, `t(${JSON.stringify(node.value)})`); return { skip: true }; }
    if (node.type === 'TemplateLiteral' && latin(node.quasis.map((q) => q.value.cooked).join(''))) { add(node.start, node.end, templateToCall(src, node)); return { skip: true }; }
  }, null);

  // apply from the end so offsets stay valid; drop nested edits
  edits.sort((a, b) => b.start - a.start);
  let out = src, lastStart = Infinity, n = 0;
  for (const e of edits) {
    if (e.end > lastStart) continue;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start; n++;
  }
  fs.writeFileSync(file, out);
  console.log(file, n, 'texts marked');
}
process.argv.slice(2).forEach(processFile);
