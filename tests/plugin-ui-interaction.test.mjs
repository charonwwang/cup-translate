import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness } from './helpers/componentHarness.mjs';

test('plugin selection closes the picker before opening its configuration dialog', async () => {
    const events = [];
    const h = await componentHarness(
        'src/window/Config/pages/Service/SelectPluginModal/index.jsx',
        'SelectPluginModal',
        {
            useToastStyle: () => ({}),
            Toaster: 'Toaster',
            MdDeleteOutline: 'MdDeleteOutline',
            createServiceInstanceKey: (name) => `${name}@test`,
        }
    );
    const root = h.render({
        isOpen: true,
        onOpenChange() {},
        pluginType: 'translate',
        pluginList: { 'plugin.cup.fixture.translate': { display: 'Fixture', icon: 'fixture.svg' } },
        setCurrentConfigKey: (key) => events.push(key),
        onConfigOpen: () => events.push('open'),
    });
    const content = h.find(root, (node) => node.type === 'ModalContent').props.children[0](() => events.push('close'));
    h.find(content, (node) => node.type === 'Button' && node.props.startContent).props.onPress();
    assert.deepEqual(events, ['close', 'plugin.cup.fixture.translate@test', 'open']);
});
