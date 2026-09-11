/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
