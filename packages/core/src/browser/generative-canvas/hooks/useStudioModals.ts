/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { ModalType, StudioSettingsTab } from '../canvas-types';

export interface UseStudioModalsReturn {
    activeModal: ModalType | null;
    settingsInitialTab: StudioSettingsTab;
    openModal: (modal: ModalType) => void;
    closeModal: () => void;
    openSettingsToTab: (tab: StudioSettingsTab) => void;
    isModalOpen: (modal: ModalType) => boolean;
}

export function useStudioModals(initialTab: StudioSettingsTab = 'general'): UseStudioModalsReturn {
    const [activeModal, setActiveModal] = React.useState<ModalType | null>(null);
    const [settingsInitialTab, setSettingsInitialTab] = React.useState<StudioSettingsTab>(initialTab);

    const openModal = React.useCallback((modal: ModalType) => {
        setActiveModal(modal);
    }, []);

    const closeModal = React.useCallback(() => {
        setActiveModal(null);
    }, []);

    const openSettingsToTab = React.useCallback((tab: StudioSettingsTab) => {
        setSettingsInitialTab(tab);
        setActiveModal('settings');
    }, []);

    const isModalOpen = React.useCallback((modal: ModalType) => {
        return activeModal === modal;
    }, [activeModal]);

    return {
        activeModal,
        settingsInitialTab,
        openModal,
        closeModal,
        openSettingsToTab,
        isModalOpen
    };
}
