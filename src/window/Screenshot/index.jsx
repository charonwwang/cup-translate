import React, { useEffect, useState, useRef } from 'react';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { currentMonitor } from '@tauri-apps/api/window';
import { convertFileSrc } from '@tauri-apps/api/tauri';
import { appWindow } from '@tauri-apps/api/window';
import { emit } from '@tauri-apps/api/event';
import { warn } from 'tauri-plugin-log-api';
import { invoke } from '@tauri-apps/api';
import { cropRectFromPointer } from '../../utils/screenshot-geometry';

export default function Screenshot() {
    const [imgurl, setImgurl] = useState('');
    const [isMoved, setIsMoved] = useState(false);
    const [isDown, setIsDown] = useState(false);
    const [mouseDownX, setMouseDownX] = useState(0);
    const [mouseDownY, setMouseDownY] = useState(0);
    const [mouseMoveX, setMouseMoveX] = useState(0);
    const [mouseMoveY, setMouseMoveY] = useState(0);

    const imgRef = useRef();

    useEffect(() => {
        let active = true;
        async function capture() {
            try {
                const monitor = await currentMonitor();
                if (!monitor) throw new Error('No current monitor');
                await invoke('screenshot', { x: monitor.position.x, y: monitor.position.y });
                const filePath = await join(await appCacheDir(), 'pot_screenshot.png');
                if (active) setImgurl(convertFileSrc(filePath));
            } catch (error) {
                await warn(`Screenshot failed: ${error}`);
                if (active) await appWindow.close();
            }
        }
        void capture();
        return () => {
            active = false;
        };
    }, []);

    return (
        <>
            <img
                ref={imgRef}
                className='fixed top-0 left-0 w-full select-none'
                src={imgurl}
                draggable={false}
                onLoad={() => {
                    if (imgurl !== '' && imgRef.current.complete) {
                        void appWindow.show();
                        void appWindow.setFocus();
                        void appWindow.setResizable(false);
                    }
                }}
            />
            <div
                className={`fixed bg-[#2080f020] border border-solid border-sky-500 ${!isMoved && 'hidden'}`}
                style={{
                    top: Math.min(mouseDownY, mouseMoveY),
                    left: Math.min(mouseDownX, mouseMoveX),
                    bottom: screen.height - Math.max(mouseDownY, mouseMoveY),
                    right: screen.width - Math.max(mouseDownX, mouseMoveX),
                }}
            />
            <div
                className='fixed top-0 left-0 bottom-0 right-0 cursor-crosshair select-none'
                onMouseDown={(e) => {
                    if (e.buttons === 1) {
                        setIsDown(true);
                        setMouseDownX(e.clientX);
                        setMouseDownY(e.clientY);
                    } else {
                        void appWindow.close();
                    }
                }}
                onMouseMove={(e) => {
                    if (isDown) {
                        setIsMoved(true);
                        setMouseMoveX(e.clientX);
                        setMouseMoveY(e.clientY);
                    }
                }}
                onMouseUp={async (e) => {
                    await appWindow.hide();
                    setIsDown(false);
                    setIsMoved(false);
                    const image = imgRef.current;
                    const crop = cropRectFromPointer(
                        mouseDownX,
                        mouseDownY,
                        e.clientX,
                        e.clientY,
                        image?.getBoundingClientRect(),
                        image?.naturalWidth,
                        image?.naturalHeight
                    );
                    if (!crop) {
                        await warn('Screenshot area is too small');
                        await appWindow.close();
                    } else {
                        try {
                            await invoke('cut_image', crop);
                            await emit('success');
                        } catch (error) {
                            await warn(`Screenshot crop failed: ${error}`);
                        } finally {
                            await appWindow.close();
                        }
                    }
                }}
            />
        </>
    );
}
