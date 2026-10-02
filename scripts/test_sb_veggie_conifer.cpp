#include "scratchbox_engine.hpp"
#include "scratchbox_sb_veggie.hpp"
#include "scratchbox_botanical_texture.hpp"
#include "scratchbox_io.hpp"
#include <iostream>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::sb_veggie;
using namespace scratchbox::botanical;
using namespace scratchbox::io;

int main() {
    std::cout << "Synthesizing test SB-Veggie Conifer..." << std::endl;
    SbVeggieTemplate tmpl = SbVeggieModelBuilder::buildCanonicalTemplate(SbVeggieArchetype::ExcurrentConifer);
    SbVeggieParams params = SbVeggieParams::createNeutral();
    params.leafMorphology = 2; // Planar quad / conifer needle sprig
    params.psi_leafDensity = 0.25f; // Fast high-performance density
    params.transferEnvelopeNormals = true;
    params.branchCurvature = 0.70f;
    params.saturationScale = 0.82f;

    auto decomposed = SbVeggieEvaluator::evaluateDecomposed(tmpl, params, true);
    ScratchboxMesh tree = decomposed.getCombined();

    std::cout << "Wood vertices: " << decomposed.woodMesh.vertices.size() 
              << " Foliage vertices: " << decomposed.foliageMesh.vertices.size()
              << " Total: " << tree.vertices.size() << " verts, "
              << tree.indices.size() / 3 << " tris." << std::endl;

    auto glbBytes = GlbWriter::writeGlb(tree);
    std::cout << "Serialized GLB bytes: " << glbBytes.size() << std::endl;
    return 0;
}
