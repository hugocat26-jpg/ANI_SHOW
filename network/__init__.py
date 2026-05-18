def __getattr__(name):
    if name == "NetworkServer":
        from .server import NetworkServer
        return NetworkServer
    if name == "DataSync":
        from .sync import DataSync
        return DataSync
    raise AttributeError(name)
