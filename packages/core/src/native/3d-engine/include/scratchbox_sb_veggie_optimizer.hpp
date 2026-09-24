/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SB-Veggie (Scratchbox Vegetation) Native C++20 Scan Inversion Optimizer.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_SB_VEGGIE_OPTIMIZER_HPP
#define SCRATCHBOX_SB_VEGGIE_OPTIMIZER_HPP

#include "scratchbox_sb_veggie.hpp"
#include "scratchbox_smpl_optimizer.hpp"

namespace scratchbox {
namespace sb_veggie {

using SbVeggieOptimizerOptions = SmplOptimizerOptions;
using SbVeggieOptimizerResult = SmplOptimizerResult;
using SbVeggieOptimizer = SmplTreeOptimizer;

} // namespace sb_veggie
} // namespace scratchbox

#endif // SCRATCHBOX_SB_VEGGIE_OPTIMIZER_HPP
