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
                        background: '#171512',
                        foreground: '#f2ede7',
                        content1: '#1f1c19',
                        content2: '#27231f',
                        content3: '#302b26',
                        content4: '#39332d',
                        default: {
                            DEFAULT: '#484848',
                            50: '#282828',
                            100: '#383838',
                            200: '#484848',
                            300: '#585858',
                            400: '#686868',
                            500: '#a7a7a7',
                            600: '#b7b7b7',
                            700: '#c7c7c7',
                            800: '#d7d7d7',
                            900: '#e7e7e7',
                        },
                        primary: {
                            DEFAULT: '#f5952f',
                            foreground: '#211d19',
                        },
                    },
                },
                light: {
                    colors: {
                        background: '#f7f5f2',
                        foreground: '#231f1b',
                        content1: '#ffffff',
                        content2: '#f1efec',
                        content3: '#e8e5e1',
                        content4: '#ded9d2',
                        default: {
                            DEFAULT: '#999999',
                            50: '#eeeeee',
                            100: '#cccccc',
                            200: '#aaaaaa',
                            300: '#999999',
                            400: '#888888',
                            500: '#686868',
                            600: '#585858',
                            700: '#484848',
                            800: '#383838',
                            900: '#282828',
                        },
                        primary: {
                            foreground: '#ffffff',
                            DEFAULT: '#e87522',
                        },
                    },
                },
            },
        }),
    ],
};
