import React from 'react';
import { useTranslation } from 'react-i18next';
export default function ModelWizardSteps({ step }) {
    const { t } = useTranslation();
    return (
        <div
            className='model-wizard-steps'
            aria-label={t('models.wizard_steps')}
        >
            {['wizard_step_choose', 'wizard_step_check', 'wizard_step_install'].map((key, index) => (
                <span
                    key={key}
                    className={step === index + 1 ? 'active' : step > index + 1 ? 'complete' : ''}
                >
                    <i>{index + 1}</i>
                    {t(`models.${key}`)}
                </span>
            ))}
        </div>
    );
}
