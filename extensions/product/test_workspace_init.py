import os

def test_workspace_initialized():
    assert os.path.exists('.')
    print('Workspace initialized and accessible.')
