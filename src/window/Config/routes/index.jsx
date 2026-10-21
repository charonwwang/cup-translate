import { lazy } from 'react';
import { Navigate } from 'react-router-dom';

const Models = lazy(() => import('../pages/Models'));
const Translate = lazy(() => import('../pages/Translate'));
const Recognize = lazy(() => import('../pages/Recognize'));
const General = lazy(() => import('../pages/General'));
const Service = lazy(() => import('../pages/Service'));
const History = lazy(() => import('../pages/History'));
const Hotkey = lazy(() => import('../pages/Hotkey'));
const About = lazy(() => import('../pages/About'));

const routes = [
    { path: '/models', element: <Models /> },
    {
        path: '/general',
        element: <General />,
    },
    {
        path: '/translate',
        element: <Translate />,
    },
    {
        path: '/recognize',
        element: <Recognize />,
    },
    {
        path: '/hotkey',
        element: <Hotkey />,
    },
    {
        path: '/service',
        element: <Service />,
    },
    {
        path: '/history',
        element: <History />,
    },
    {
        path: '/backup',
        element: (
            <Navigate
                to='/general'
                replace
            />
        ),
    },
    {
        path: '/about',
        element: <About />,
    },
    {
        path: '/',
        element: <Navigate to='/general' />,
    },
];

export default routes;
