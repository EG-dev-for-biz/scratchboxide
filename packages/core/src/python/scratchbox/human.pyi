from typing import Optional, Tuple, Any

class Human:
    role: str
    height: float
    gender_beta: float
    pose: str
    position: Tuple[float, float, float]
    facing_deg: float
    surface: Optional[Any]
    surface_y_offset: float

    def __init__(
        self,
        role: str = ...,
        height: float = ...,
        gender_beta: float = ...,
        pose: str = ...,
        position: Tuple[float, float, float] = ...,
        facing_deg: float = ...,
        surface: Optional[Any] = ...,
        surface_y_offset: float = ...,
    ) -> None: ...

    def stand_on(
        self,
        surface: Any,
        offset: Tuple[float, float] = ...,
        y_offset: float = ...,
        facing_deg: Optional[float] = ...
    ) -> Human: ...

    @property
    def mesh(self) -> Any: ...

    def build_mesh(self) -> Any: ...

def create_human(
    role: str = ...,
    height: float = ...,
    gender_beta: float = ...,
    pose: str = ...,
    position: Tuple[float, float, float] = ...,
    facing_deg: float = ...,
    surface: Optional[Any] = ...,
    surface_y_offset: float = ...,
    **kwargs: Any
) -> Human: ...
