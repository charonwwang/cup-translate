import React from 'react';
import { useTranslation } from 'react-i18next';
export default function ModelWizardSteps({ step }) {
    const { t } = useTranslation();
    return (
        <ol
            className='model-wizard-steps'
            aria-label={t('models.wizard_steps')}
        >
            {['wizard_step_choose', 'wizard_step_check', 'wizard_step_install'].map((key, index) => (
                <li
                    key={key}
                    aria-current={step === index + 1 ? 'step' : undefined}
                    className={step === index + 1 ? 'active' : step > index + 1 ? 'complete' : ''}
                >
                    <i aria-hidden='true'>{step > index + 1 ? '✓' : index + 1}</i>
                    {t(`models.${key}`)}
                </li>
            ))}
        </ol>
    );
}
