#!/usr/bin/env python3
"""Run with: ~/.cache/scratchbox/matchmove-venv/bin/python -m unittest test_bridge_track (from scripts/matchmove)."""
import unittest

import numpy as np
from scipy.spatial.transform import Rotation

from bridge_track import bend_track, merge_walks


def synthetic_tracks(n=60, warp=0.02):
    """True tile-frame track, plus an SfM track that is a similarity of it with a smooth non-rigid warp."""
    frames = np.arange(1, n + 1)
    true_pose, sfm_pose = {}, {}
    Rw = Rotation.from_euler('xyz', [5, 40, -3], degrees=True).as_matrix()
    s, T = 6.0, np.array([40.0, 10.0, 30.0])
    for f in frames:
        C = np.array([0.3 * f, 20.0 - 0.2 * f + np.sin(f / 10.0), 5.0 + 0.1 * f])
        R = Rotation.from_euler('yxz', [0.8 * f, -10.0 - 0.3 * f, 0.0], degrees=True).as_matrix()
        true_pose[int(f)] = (R, C)
        C_sfm = Rw.T @ (C - T) / s + np.array([warp * (f / 10.0) ** 1.5, 0.0, 0.0])
        sfm_pose[int(f)] = (R @ Rw, C_sfm)
    return frames, true_pose, sfm_pose


def rot_err(Ra, Rb):
    return float(np.linalg.norm(Rotation.from_matrix(Ra.T @ Rb).as_rotvec()))


class BendTrackTest(unittest.TestCase):
    def setUp(self):
        self.frames, self.true_pose, self.sfm_pose = synthetic_tracks()
        self.anchor_frames = list(range(1, 11)) + list(range(50, 61))
        self.anchors = {f: self.true_pose[f] for f in self.anchor_frames}

    def test_reproduces_anchor_poses_exactly_without_jitter_smoothing(self):
        poses, _ = bend_track(self.sfm_pose, self.frames, self.anchors, jitter_sigma=0)
        for f in self.anchor_frames:
            self.assertLess(np.linalg.norm(poses[f][1] - self.true_pose[f][1]), 1e-6)
            self.assertLess(rot_err(poses[f][0], self.true_pose[f][0]), 1e-6)

    def test_light_smoothing_stays_close_to_anchors(self):
        poses, _ = bend_track(self.sfm_pose, self.frames, self.anchors, jitter_sigma=1.0)
        for f in self.anchor_frames:
            self.assertLess(np.linalg.norm(poses[f][1] - self.true_pose[f][1]), 0.05)

    def test_gap_is_closer_to_truth_than_a_single_similarity(self):
        bent, _ = bend_track(self.sfm_pose, self.frames, self.anchors, jitter_sigma=0)
        gap = range(11, 50)
        err_bent = max(np.linalg.norm(bent[f][1] - self.true_pose[f][1]) for f in gap)
        rigid = {f: self.anchors[f] for f in self.anchor_frames}
        from track_frames_on_tiles import umeyama
        s, Rw, Tw = umeyama(np.array([self.sfm_pose[k][1] for k in rigid]), np.array([rigid[k][1] for k in rigid]))
        err_rigid = max(np.linalg.norm(s * Rw @ self.sfm_pose[f][1] + Tw - self.true_pose[f][1]) for f in gap)
        self.assertLess(err_bent, err_rigid)

    def test_holds_correction_outside_the_anchor_range(self):
        anchors = {f: self.true_pose[f] for f in range(20, 41)}
        poses, _ = bend_track(self.sfm_pose, self.frames, anchors, jitter_sigma=0)
        for f in self.frames:
            self.assertTrue(np.isfinite(poses[int(f)][1]).all())
        self.assertLess(np.linalg.norm(poses[1][1] - self.true_pose[1][1]), 1.0)


class MergeWalksTest(unittest.TestCase):
    I = np.eye(3)

    def pose(self, x, inliers=100):
        return (self.I, np.array([x, 0.0, 0.0]), (inliers, 2.0))

    def test_keeps_frames_where_both_walks_agree(self):
        kept, disagree = merge_walks([60], {60: self.pose(10.0, 80)}, {60: self.pose(10.4, 120)}, 40, 90, 1.0, 8)
        self.assertEqual([(f, how) for f, _, how in kept], [(60, 'both')])
        self.assertEqual(kept[0][1][2][0], 120)
        self.assertEqual(disagree, [])

    def test_rejects_frames_where_walks_disagree_by_a_floor(self):
        kept, disagree = merge_walks([60], {60: self.pose(10.0)}, {60: self.pose(14.0)}, 40, 90, 1.0, 8)
        self.assertEqual(kept, [])
        self.assertEqual([d['frame'] for d in disagree], [60])

    def test_single_direction_frames_only_near_their_start_anchor(self):
        fwd = {44: self.pose(1.0), 60: self.pose(2.0)}
        bwd = {86: self.pose(3.0), 70: self.pose(4.0)}
        kept, _ = merge_walks([44, 60, 70, 86], fwd, bwd, 40, 90, 1.0, 8)
        self.assertEqual([(f, how) for f, _, how in kept], [(44, 'forward'), (86, 'backward')])


if __name__ == '__main__':
    unittest.main()
