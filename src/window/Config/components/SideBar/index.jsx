import { useNavigate, useLocation } from 'react-router-dom';
import { BsInfoSquareFill } from 'react-icons/bs';
import { PiTranslateFill } from 'react-icons/pi';
import { AiFillAppstore } from 'react-icons/ai';
import { useTranslation } from 'react-i18next';
import { PiTextboxFill } from 'react-icons/pi';
import { MdKeyboardAlt } from 'react-icons/md';
import { MdExtension } from 'react-icons/md';
import { AiFillCloud } from 'react-icons/ai';
import { FaHistory } from 'react-icons/fa';
import { Button } from '@nextui-org/react';
import React from 'react';

export default function SideBar() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();

    function setStyle(pathname) {
        return location.pathname.includes(pathname) ? 'flat' : 'light';
    }

    return (
        <div className='config-nav mx-[10px] overflow-y-auto'>
            <Button
                fullWidth
                size='lg'
                variant={setStyle('/general')}
                className='config-nav-item mb-[3px]'
                onPress={() => {
                    navigate('/general');
                }}
                startContent={<AiFillAppstore className='text-[18px]' />}
            >
                <div className='w-full'>{t('config.general.label')}</div>
            </Button>
            <Button
                fullWidth
                size='lg'
                variant={setStyle('/translate')}
                className='config-nav-item mb-[3px]'
                onPress={() => {
                    navigate('/translate');
                }}
                startContent={<PiTranslateFill className='text-[18px]' />}
            >
                <div className='w-full'>{t('config.translate.label')}</div>
            </Button>
            <Button
                fullWidth
                size='lg'
                variant={setStyle('/recognize')}
                className='config-nav-item mb-[3px]'
                onPress={() => {
                    navigate('/recognize');
                }}
                startContent={<PiTextboxFill className='text-[18px]' />}
            >
                <div className='w-full'>{t('config.recognize.label')}</div>
            </Button>
            <Button
                fullWidth
                size='lg'
                variant={setStyle('/hotkey')}
                className='config-nav-item mb-[3px]'
                onPress={() => {
                    navigate('/hotkey');
                }}
                startContent={<MdKeyboardAlt className='text-[18px]' />}
            >
                <div className='w-full'>{t('config.hotkey.label')}</div>
            </Button>
            <Button
                fullWidth
                size='lg'
                variant={setStyle('/service')}
                className='config-nav-item mb-[3px]'
                onPress={() => {
                    navigate('/service');
                }}
                startContent={<MdExtension className='text-[18px]' />}
            >
                <div className='w-full'>{t('config.service.label')}</div>
            </Button>
            <Button
                fullWidth
                size='lg'
                variant={setStyle('/history')}
                className='config-nav-item mb-[3px]'
                onPress={() => {
                    navigate('/history');
                }}
                startContent={<FaHistory className='text-[18px]' />}
            >
                <div className='w-full'>{t('config.history.label')}</div>
            </Button>
            <Button
                fullWidth
                size='lg'
                variant={setStyle('/backup')}
                className='config-nav-item mb-[3px]'
                onPress={() => {
                    navigate('/backup');
                }}
                startContent={<AiFillCloud className='text-[18px]' />}
            >
                <div className='w-full'>{t('config.backup.label')}</div>
            </Button>
            <Button
                fullWidth
                size='lg'
                variant={setStyle('/about')}
                className='config-nav-item mb-[3px]'
                onPress={() => {
                    navigate('/about');
                }}
                startContent={<BsInfoSquareFill className='text-[18px]' />}
            >
                <div className='w-full'>{t('config.about.label')}</div>
            </Button>
        </div>
    );
}
