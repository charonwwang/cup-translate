// tailwind.config.js
const { nextui } = require('@nextui-org/react');

/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        // ...
        './index.html',
        './src/**/*.{js,ts,jsx,tsx}',
        './node_modules/@nextui-org/theme/dist/**/*.{js,ts,jsx,tsx}',
    ],
    theme: {
        extend: {},
    },
    darkMode: 'class',
    plugins: [
        nextui({
            themes: {
                dark: {
                    colors: {
                        background: '#18231e',
                        foreground: '#e1eae4',
                        content1: '#202e28',
                        content2: '#25332b',
                        content3: '#2c3d33',
                        content4: '#35453c',
                        default: {
                            DEFAULT: '#405549',
                            50: '#26382e',
                            100: '#35453c',
                            200: '#405549',
                            300: '#53665a',
                            400: '#697971',
                            500: '#a7a7a7',
                            600: '#b7b7b7',
                            700: '#c7c7c7',
                            800: '#d7d7d7',
                            900: '#e7e7e7',
                        },
                        primary: {
                            DEFAULT: '#90d4b5',
                            foreground: '#15251d',
                        },
                    },
                },
                light: {
                    colors: {
                        background: '#f5f7f5',
                        foreground: '#23332e',
                        content1: '#ffffff',
                        content2: '#f7f9f7',
                        content3: '#edf2ee',
                        content4: '#e5ebe7',
                        default: {
                            DEFAULT: '#94a69a',
                            50: '#f3f6f3',
                            100: '#e5ebe7',
                            200: '#c9d5cd',
                            300: '#94a69a',
                            400: '#7c9083',
                            500: '#697971',
                            600: '#53665a',
                            700: '#405549',
                            800: '#35453c',
                            900: '#26382e',
                        },
                        primary: {
                            foreground: '#ffffff',
                            DEFAULT: '#24735c',
                        },
                    },
                },
            },
        }),
    ],
};
