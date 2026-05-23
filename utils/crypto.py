"""
加密工具模块
新写入使用 AES-256-GCM；旧 AES-256-CBC 密文保留只读兼容。
"""
import base64
import hashlib
import json
import os
from typing import Optional

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad


class CryptoUtil:
    """AES加密工具"""

    # 使用机器唯一标识生成默认密钥（生产环境建议使用更安全的方式）
    _default_key: Optional[bytes] = None

    @classmethod
    def _get_default_key(cls) -> bytes:
        if cls._default_key is None:
            # 基于计算机名+用户名的hash生成密钥
            raw = f"{os.environ.get('COMPUTERNAME', '')}{os.environ.get('USERNAME', '')}".encode()
            cls._default_key = hashlib.sha256(raw).digest()
        return cls._default_key

    @classmethod
    def encrypt(cls, plaintext: str, key: Optional[bytes] = None) -> str:
        """
        AES-256-GCM 加密
        返回带版本前缀的 base64 编码密文（nonce + tag + ciphertext）
        """
        if key is None:
            key = cls._get_default_key()
        nonce = os.urandom(12)
        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
        encrypted, tag = cipher.encrypt_and_digest(plaintext.encode("utf-8"))
        return "gcm:" + base64.b64encode(nonce + tag + encrypted).decode("utf-8")

    @classmethod
    def decrypt(cls, ciphertext: str, key: Optional[bytes] = None) -> str:
        """
        AES-256-GCM 解密；无版本前缀时按旧 AES-256-CBC 解密。
        """
        if key is None:
            key = cls._get_default_key()
        if ciphertext.startswith("gcm:"):
            raw = base64.b64decode(ciphertext[4:].encode("utf-8"))
            nonce = raw[:12]
            tag = raw[12:28]
            encrypted = raw[28:]
            cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
            return cipher.decrypt_and_verify(encrypted, tag).decode("utf-8")
        raw = base64.b64decode(ciphertext.encode("utf-8"))
        iv = raw[:16]
        encrypted = raw[16:]
        cipher = AES.new(key, AES.MODE_CBC, iv)
        decrypted = unpad(cipher.decrypt(encrypted), AES.block_size)
        return decrypted.decode("utf-8")

    @classmethod
    def hash_password(cls, password: str) -> str:
        """对密码进行SHA256哈希"""
        salt = os.urandom(16)
        hash_bytes = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, 100000
        )
        return base64.b64encode(salt + hash_bytes).decode("utf-8")

    @classmethod
    def verify_password(cls, password: str, hashed: str) -> bool:
        """验证密码是否正确"""
        raw = base64.b64decode(hashed.encode("utf-8"))
        salt = raw[:16]
        stored_hash = raw[16:]
        new_hash = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, 100000
        )
        return new_hash == stored_hash
