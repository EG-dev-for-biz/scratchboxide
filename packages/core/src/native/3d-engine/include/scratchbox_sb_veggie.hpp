/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SB-Veggie (Scratchbox Vegetation) Native C++20 Parametric Botanical Model.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_SB_VEGGIE_HPP
#define SCRATCHBOX_SB_VEGGIE_HPP

#include "scratchbox_smpl_tree.hpp"

namespace scratchbox {
namespace sb_veggie {

using namespace smpl_tree;

using SbVeggieArchetype = SmplTreeArchetype;
using SbVeggieJoint = SmplTreeJoint;
using SbVeggieParams = SmplTreeParams;
using SbVeggieTemplate = SmplTreeTemplate;
using SbVeggieModelBuilder = SmplTreeModelBuilder;
using SbVeggieEvaluator = SmplTreeEvaluator;

} // namespace sb_veggie

namespace veggie = sb_veggie;

} // namespace scratchbox

#endif // SCRATCHBOX_SB_VEGGIE_HPP
