// Execute component handlers and effects with deterministic hook state, without a DOM.
// This covers controller behavior; it deliberately does not claim focus/layout coverage.
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
export async function componentHarness(path, name, bindings) {
    const source = (await readFile(path, 'utf8'))
        .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
        .replace('export default function', 'function')
        .replace(/^export (?=(?:async )?function|const)/gm, '');
    const { code } = await transformWithEsbuild(source, path, { loader: 'jsx', jsx: 'transform' });
    const slots = [],
        effects = [],
        timers = [];
    let cursor = 0,
        props;
    const hooks = {
        useState(initial) {
            const id = cursor++;
            if (!(id in slots)) slots[id] = initial;
            return [
                slots[id],
                (value) => {
                    slots[id] = typeof value === 'function' ? value(slots[id]) : value;
                },
            ];
        },
        useRef(initial) {
            const id = cursor++;
            return (slots[id] ||= { current: initial });
        },
        useEffect(fn, deps) {
            const id = cursor++,
                old = slots[id];
            if (!old || deps.some((v, i) => v !== old.deps[i])) {
                old?.cleanup?.();
                slots[id] = { deps };
                effects.push(() => {
                    slots[id].cleanup = fn();
                });
            }
        },
    };
    const React = {
        createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    };
    const ui = Object.fromEntries(
        [
            'Modal',
            'ModalContent',
            'ModalHeader',
            'ModalBody',
            'ModalFooter',
            'Button',
            'Select',
            'SelectItem',
            'Checkbox',
            'Progress',
            'Input',
            'Spacer',
            'ModelWizardSteps',
        ].map((s) => [s, s])
    );
    const context = {
        React,
        ...hooks,
        ...ui,
        useTranslation: () => ({ t: (s) => s }),
        setInterval: (fn) => {
            timers.push(fn);
            return fn;
        },
        clearInterval: () => {},
        ...bindings,
    };
    const component = new Function(...Object.keys(context), `${code}; return ${name}`)(...Object.values(context));
    const render = (next = props) => {
        props = next;
        cursor = 0;
        const tree = component(props);
        while (effects.length) effects.shift()();
        return tree;
    };
    return {
        hooks,
        render,
        timers,
        find(tree, predicate) {
            const walk = (node) => {
                if (!node || typeof node !== 'object') return;
                if (predicate(node)) return node;
                for (const child of node.props?.children || []) {
                    const result = walk(child);
                    if (result) return result;
                }
            };
            const found = walk(tree);
            if (!found) throw new Error('Control not found');
            return found;
        },
    };
}
