import ModelWizardSteps from './ModelWizardSteps';
import React from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from '@nextui-org/react';
import { useTranslation } from 'react-i18next';
export default function SpeechModels({ open, onClose, onSelect }) {
    const { t } = useTranslation();
    return (
        <Modal
            isOpen={open}
            onClose={onClose}
            size='2xl'
            classNames={{
                base: 'model-install-dialog',
                header: 'model-install-header',
                body: 'model-install-body',
                footer: 'model-install-footer',
            }}
        >
            <ModalContent>
                <ModalHeader>
                    <div>
                        <h2>{t('models.speech_family_title')}</h2>
                        <p>{t('models.speech_family_intro')}</p>
                    </div>
                </ModalHeader>
                <ModalBody>
                    <ModelWizardSteps step={1} />
                    <div className='model-family-grid speech-family-grid'>
                        <button
                            className='model-family-card'
                            onClick={() => onSelect('qwen')}
                        >
                            <strong>Qwen3-TTS</strong>
                            <span>{t('models.qwen_intro')}</span>
                            <small>0.6B / 1.7B · CustomVoice · Apache-2.0</small>
                            <small>{t('models.local_service')}</small>
                        </button>
                        <button
                            className='model-family-card'
                            onClick={() => onSelect('kokoro')}
                        >
                            <strong>Kokoro</strong>
                            <span>{t('models.kokoro_family')}</span>
                            <small>82M · INT8 · Apache-2.0</small>
                        </button>
                        <button
                            className='model-family-card'
                            onClick={() => onSelect('piper')}
                        >
                            <strong>Piper</strong>
                            <span>{t('models.piper_family')}</span>
                            <small>VITS · ONNX · CPU</small>
                        </button>
                    </div>
                </ModalBody>
                <ModalFooter>
                    <Button
                        size='sm'
                        onPress={onClose}
                    >
                        {t('common.cancel')}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
}
