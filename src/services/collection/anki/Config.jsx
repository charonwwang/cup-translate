import React from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigEditor } from '../ConfigEditor';
import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { nextPortValue } from '../../../utils/port';
import { ANKI_DEFAULT_PORT } from './port';
import { testConnection } from './index';
export function Config({ instanceKey, onEditorStateChange }) {
    const { t } = useTranslation();
    return (
        <ConfigEditor
            instanceKey={instanceKey}
            onEditorStateChange={onEditorStateChange}
            defaults={{ [INSTANCE_NAME_CONFIG_KEY]: t('services.collection.anki.title'), port: ANKI_DEFAULT_PORT }}
            guide='services.collection.anki.guide'
            testConnection={testConnection}
            normalize={(key, value) => (key === 'port' ? nextPortValue(value) : value)}
            fields={[
                { key: INSTANCE_NAME_CONFIG_KEY, label: 'services.instance_name' },
                { key: 'port', label: 'services.collection.anki.port', type: 'number' },
                { key: 'apiKey', label: 'services.collection.anki.api_key', secret: true },
            ]}
        />
    );
}
