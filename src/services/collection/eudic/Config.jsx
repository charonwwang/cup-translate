import React from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigEditor } from '../ConfigEditor';
import { INSTANCE_NAME_CONFIG_KEY } from '../../../utils/service_instance';
import { testConnection } from './index';
export function Config({ instanceKey, onEditorStateChange }) {
    const { t } = useTranslation();
    return (
        <ConfigEditor
            instanceKey={instanceKey}
            onEditorStateChange={onEditorStateChange}
            defaults={{ [INSTANCE_NAME_CONFIG_KEY]: t('services.collection.eudic.title'), name: 'pot', token: '' }}
            guide='services.collection.eudic.guide'
            testConnection={testConnection}
            fields={[
                { key: INSTANCE_NAME_CONFIG_KEY, label: 'services.instance_name' },
                { key: 'name', label: 'services.collection.eudic.name' },
                { key: 'token', label: 'services.collection.eudic.token', secret: true },
            ]}
        />
    );
}
