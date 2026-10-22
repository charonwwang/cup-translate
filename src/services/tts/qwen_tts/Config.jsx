import React from 'react';
import QwenSpeech from '../../../window/Config/pages/Models/QwenSpeech';
export function Config({ instanceKey, updateServiceList, onClose }) {
    return (
        <QwenSpeech
            open
            onClose={onClose}
            onSaved={() => updateServiceList(instanceKey)}
        />
    );
}
