/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A fixed-size thread pool: `threads` workers for the life of the pool, never more, so builds sharing a machine (a
 * chunked district's builds, pipeline-k/district-chunks.ts chunkCpuShare) each keep to their share of the cores.
 *
 * - submit(task): run on a worker, in submission order as workers free up.
 * - forEach(n, fn): fn(0..n-1) spread over the pool and the calling thread; returns when every call has returned. The
 *   caller works through the items itself while it waits, so a task may call forEach without deadlocking the pool (a
 *   pool of one thread runs every item on the caller). Items are claimed in order; which thread runs one is not fixed,
 *   so fn must write only its own item's result. The first exception an item throws is rethrown to the caller once
 *   every item has returned or thrown.
 * - wait(): until every submitted task has finished.
 */

#pragma once

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace scratchbox {

class FixedThreadPool {
public:
    explicit FixedThreadPool(unsigned threads) {
        const unsigned n = std::max(1u, threads);
        workers_.reserve(n);
        for (unsigned i = 0; i < n; ++i) workers_.emplace_back([this] { work(); });
    }
    FixedThreadPool(const FixedThreadPool&) = delete;
    FixedThreadPool& operator=(const FixedThreadPool&) = delete;
    ~FixedThreadPool() {
        {
            std::lock_guard<std::mutex> lock(m_);
            stop_ = true;
        }
        cv_.notify_all();
        for (auto& t : workers_) t.join();
    }

    unsigned size() const { return static_cast<unsigned>(workers_.size()); }

    void submit(std::function<void()> task) {
        {
            std::lock_guard<std::mutex> lock(m_);
            q_.push_back(std::move(task));
            ++pending_;
        }
        cv_.notify_one();
    }

    void wait() {
        std::unique_lock<std::mutex> lock(m_);
        idle_.wait(lock, [this] { return pending_ == 0; });
    }

    template <class F>
    void forEach(size_t n, F&& fn) {
        if (n == 0) return;
        if (n == 1 || workers_.size() <= 1) {
            for (size_t i = 0; i < n; ++i) fn(i);
            return;
        }
        struct Group {
            std::atomic<size_t> next{0};
            size_t done = 0;
            std::exception_ptr error;
            std::mutex m;
            std::condition_variable cv;
        };
        auto g = std::make_shared<Group>();
        const auto drain = [g, n, &fn] {
            size_t ran = 0;
            std::exception_ptr err;
            for (size_t i; (i = g->next.fetch_add(1)) < n;) {
                try { fn(i); } catch (...) { if (!err) err = std::current_exception(); }
                ++ran;
            }
            if (!ran) return;
            std::lock_guard<std::mutex> lock(g->m);
            if (err && !g->error) g->error = err;
            g->done += ran;
            if (g->done == n) g->cv.notify_all();
        };
        // the helpers hold `fn` by reference: they run no item once every item is claimed, and the caller returns only
        // after every claimed item has finished
        const size_t helpers = std::min<size_t>(workers_.size(), n - 1);
        for (size_t h = 0; h < helpers; ++h) submit(drain);
        drain();
        std::unique_lock<std::mutex> lock(g->m);
        g->cv.wait(lock, [&] { return g->done == n; });
        if (g->error) std::rethrow_exception(g->error);
    }

private:
    void work() {
        for (;;) {
            std::function<void()> task;
            {
                std::unique_lock<std::mutex> lock(m_);
                cv_.wait(lock, [this] { return stop_ || !q_.empty(); });
                if (q_.empty()) return;
                task = std::move(q_.front());
                q_.pop_front();
            }
            task();
            std::lock_guard<std::mutex> lock(m_);
            if (--pending_ == 0) idle_.notify_all();
        }
    }

    std::vector<std::thread> workers_;
    std::deque<std::function<void()>> q_;
    std::mutex m_;
    std::condition_variable cv_, idle_;
    size_t pending_ = 0;
    bool stop_ = false;
};

}  // namespace scratchbox
