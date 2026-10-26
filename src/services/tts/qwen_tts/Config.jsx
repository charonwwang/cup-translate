import React from 'react';
import QwenSpeech from '../../../window/Config/pages/Models/QwenSpeech';
export function Config({ open, onClose }) {
    return (
        <QwenSpeech
            open={open}
            onClose={onClose}
            mode='service'
        />
    );
}
