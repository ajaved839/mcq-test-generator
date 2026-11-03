import type { Element } from '@xmldom/xmldom';
import type { MathNode } from '../../core/richtext';
import { attr, child, children, childrenNamed, NS, textContent } from './xml';

/**
 * Word equations (OMML) to MathML Core.
 *
 * Written in-house instead of using omml2mathml: that package has not been updated since 2022
 * and pulls in a DOM shim. This converter covers the constructs Word's equation editor
 * produces for school papers (fractions, scripts, radicals, n-ary operators, delimiters,
 * accents, bars, functions, limits, matrices and equation arrays). Anything else is kept as
 * text and reported, so review can flag it.
 */

export interface MathConversion {
  node: MathNode;
  unsupported: string[];
}

const m = (
  tag: string,
  kids: Array<MathNode | string>,
  attrs?: Record<string, string>,
): MathNode => (attrs ? { tag, attrs, children: kids } : { tag, children: kids });

const row = (kids: MathNode[]): MathNode => (kids.length === 1 ? kids[0] : m('mrow', kids));

const OPERATORS = new Set('+-−=<>≤≥≠±∓×÷·∙∘*/|()[]{},;:!∑∏∫∮∂∇→←↔⇒⇔∞∈∉⊂⊃⊆⊇∪∩∧∨¬∀∃′″%°'.split(''));

/** Splits run text into MathML tokens: numbers, identifiers, operators. */
function tokenize(value: string, normalText: boolean): MathNode[] {
  if (normalText) return value ? [m('mtext', [value])] : [];
  const out: MathNode[] = [];
  const re = /(\d+(?:[.,]\d+)?)|([A-Za-zͰ-Ͽ]+)|(\s+)|(.)/gu;
  for (const match of value.matchAll(re)) {
    if (match[1]) out.push(m('mn', [match[1]]));
    else if (match[2]) {
      // Multi-letter runs like "sin" or "log" are function names; single letters are variables.
      out.push(m('mi', [match[2]]));
    } else if (match[3]) continue;
    else if (match[4])
      out.push(OPERATORS.has(match[4]) ? m('mo', [match[4]]) : m('mi', [match[4]]));
  }
  return out;
}

function prop(node: Element, propName: string, field: string): string | null {
  const pr = child(node, NS.m, propName);
  return pr ? attr(child(pr, NS.m, field), NS.m, 'val') : null;
}

export function convertOmml(oMath: Element): MathConversion {
  const unsupported: string[] = [];

  const content = (node: Element | null): MathNode[] =>
    node ? children(node).flatMap(convert) : [];
  const arg = (node: Element, name: string): MathNode => row(content(child(node, NS.m, name)));

  function convert(node: Element): MathNode[] {
    if (node.namespaceURI === NS.w) {
      // Word runs inside equations (rare) carry plain text.
      const t = textContent(node);
      return t.trim() ? [m('mtext', [t])] : [];
    }
    if (node.namespaceURI !== NS.m) return [];
    switch (node.localName) {
      case 'r': {
        const normal = !!child(child(node, NS.m, 'rPr') ?? node, NS.m, 'nor');
        return childrenNamed(node, NS.m, 't').flatMap((t) => tokenize(textContent(t), normal));
      }
      case 'e':
      case 'num':
      case 'den':
      case 'sub':
      case 'sup':
      case 'deg':
      case 'lim':
      case 'fName':
      case 'oMath':
        return [row(content(node))];
      case 'oMathPara':
        return childrenNamed(node, NS.m, 'oMath').flatMap((o) => content(o));
      case 'f': {
        const type = prop(node, 'fPr', 'type');
        if (type === 'lin')
          return [m('mrow', [arg(node, 'num'), m('mo', ['/']), arg(node, 'den')])];
        const attrs = type === 'noBar' ? { linethickness: '0' } : undefined;
        return [m('mfrac', [arg(node, 'num'), arg(node, 'den')], attrs)];
      }
      case 'sSub':
        return [m('msub', [arg(node, 'e'), arg(node, 'sub')])];
      case 'sSup':
        return [m('msup', [arg(node, 'e'), arg(node, 'sup')])];
      case 'sSubSup':
        return [m('msubsup', [arg(node, 'e'), arg(node, 'sub'), arg(node, 'sup')])];
      case 'sPre':
        // Pre-scripts (e.g. isotopes) approximated as scripts on an empty base before the element.
        return [m('msubsup', [m('mrow', []), arg(node, 'sub'), arg(node, 'sup')]), arg(node, 'e')];
      case 'rad': {
        const hide = prop(node, 'radPr', 'degHide');
        const deg = content(child(node, NS.m, 'deg'));
        if (hide === '1' || hide === 'on' || !deg.length) return [m('msqrt', [arg(node, 'e')])];
        return [m('mroot', [arg(node, 'e'), row(deg)])];
      }
      case 'd': {
        const beg = prop(node, 'dPr', 'begChr') ?? '(';
        const end = prop(node, 'dPr', 'endChr') ?? ')';
        const sep = prop(node, 'dPr', 'sepChr') ?? '|';
        const parts = childrenNamed(node, NS.m, 'e').map((e) => row(content(e)));
        const inner: MathNode[] = [];
        parts.forEach((p, i) => {
          if (i > 0) inner.push(m('mo', [sep], { separator: 'true' }));
          inner.push(p);
        });
        return [
          m('mrow', [
            ...(beg ? [m('mo', [beg], { fence: 'true' })] : []),
            ...inner,
            ...(end ? [m('mo', [end], { fence: 'true' })] : []),
          ]),
        ];
      }
      case 'nary': {
        const chr = prop(node, 'naryPr', 'chr') ?? '∫';
        const loc = prop(node, 'naryPr', 'limLoc') ?? (chr === '∫' ? 'subSup' : 'undOvr');
        const subHide = prop(node, 'naryPr', 'subHide') === '1';
        const supHide = prop(node, 'naryPr', 'supHide') === '1';
        const op = m('mo', [chr], { largeop: 'true' });
        const sub = arg(node, 'sub');
        const sup = arg(node, 'sup');
        let base: MathNode;
        if (subHide && supHide) base = op;
        else if (loc === 'undOvr') {
          base = subHide
            ? m('mover', [op, sup])
            : supHide
              ? m('munder', [op, sub])
              : m('munderover', [op, sub, sup]);
        } else {
          base = subHide
            ? m('msup', [op, sup])
            : supHide
              ? m('msub', [op, sub])
              : m('msubsup', [op, sub, sup]);
        }
        return [m('mrow', [base, arg(node, 'e')])];
      }
      case 'acc': {
        const chr = prop(node, 'accPr', 'chr') ?? '̂';
        return [
          m('mover', [arg(node, 'e'), m('mo', [chr], { stretchy: 'false' })], { accent: 'true' }),
        ];
      }
      case 'bar': {
        const pos = prop(node, 'barPr', 'pos') ?? 'top';
        return pos === 'bot'
          ? [m('munder', [arg(node, 'e'), m('mo', ['_'])], { accentunder: 'true' })]
          : [m('mover', [arg(node, 'e'), m('mo', ['¯'])], { accent: 'true' })];
      }
      case 'groupChr': {
        const chr = prop(node, 'groupChrPr', 'chr') ?? '⏟';
        const pos = prop(node, 'groupChrPr', 'pos') ?? 'bot';
        return pos === 'top'
          ? [m('mover', [arg(node, 'e'), m('mo', [chr])])]
          : [m('munder', [arg(node, 'e'), m('mo', [chr])])];
      }
      case 'func':
        return [m('mrow', [arg(node, 'fName'), m('mo', ['⁡']), arg(node, 'e')])];
      case 'limLow':
        return [m('munder', [arg(node, 'e'), arg(node, 'lim')])];
      case 'limUpp':
        return [m('mover', [arg(node, 'e'), arg(node, 'lim')])];
      case 'm':
        return [
          m(
            'mtable',
            childrenNamed(node, NS.m, 'mr').map((mr) =>
              m(
                'mtr',
                childrenNamed(mr, NS.m, 'e').map((e) => m('mtd', [row(content(e))])),
              ),
            ),
          ),
        ];
      case 'eqArr':
        return [
          m(
            'mtable',
            childrenNamed(node, NS.m, 'e').map((e) => m('mtr', [m('mtd', [row(content(e))])])),
          ),
        ];
      case 'box':
      case 'borderBox':
        return [arg(node, 'e')];
      case 'phant':
        return [m('mphantom', [arg(node, 'e')])];
      case 'ctrlPr':
      case 'rPr':
      case 'fPr':
      case 'sSubPr':
      case 'sSupPr':
      case 'sSubSupPr':
      case 'radPr':
      case 'dPr':
      case 'naryPr':
      case 'accPr':
      case 'barPr':
      case 'funcPr':
      case 'limLowPr':
      case 'limUppPr':
      case 'mPr':
      case 'eqArrPr':
      case 'boxPr':
      case 'borderBoxPr':
      case 'phantPr':
      case 'groupChrPr':
      case 'sPrePr':
      case 'oMathParaPr':
        return [];
      default: {
        unsupported.push(node.localName ?? 'unknown');
        const t = textContent(node);
        return t.trim() ? [m('mtext', [t])] : [];
      }
    }
  }

  const display = oMath.localName === 'oMathPara';
  const body = display ? convert(oMath) : content(oMath);
  return { node: m('math', body, display ? { display: 'block' } : undefined), unsupported };
}
