using System;
using System.Security.Cryptography;
using System.Text;

namespace NeoMD.WinUI3;

/// <summary>
/// 绿色版可逆混淆（非强加密）：密钥落在 exe 同级 data/ 下，
/// 只用于 web 端 secrets.{encrypt,decrypt} 的可选桥接，不涉及任何平台凭据。
/// 实际 UI 路径未使用 secrets 桥，这里仅为兜底对齐 platform.ts。
/// </summary>
internal static class ProtectedDataLocal
{
    private static byte[] Key()
    {
        var dir = App.DataDir;
        var keyPath = System.IO.Path.Combine(dir, ".bridge-key");
        try
        {
            if (System.IO.File.Exists(keyPath))
                return System.IO.File.ReadAllBytes(keyPath);
            var b = RandomNumberGenerator.GetBytes(32);
            System.IO.File.WriteAllBytes(keyPath, b);
            return b;
        }
        catch
        {
            return Encoding.UTF8.GetBytes("neomd-winui3-local-key-v1");
        }
    }

    public static byte[] Protect(byte[] data)
    {
        var key = Key();
        using var aes = Aes.Create();
        aes.Key = key;
        aes.GenerateIV();
        using var enc = aes.CreateEncryptor();
        var body = enc.TransformFinalBlock(data, 0, data.Length);
        var outArr = new byte[aes.IV.Length + body.Length];
        Buffer.BlockCopy(aes.IV, 0, outArr, 0, aes.IV.Length);
        Buffer.BlockCopy(body, 0, outArr, aes.IV.Length, body.Length);
        return outArr;
    }

    public static byte[] Unprotect(byte[] data)
    {
        var key = Key();
        var ivLen = 16;
        if (data.Length <= ivLen) throw new InvalidOperationException("bad ciphertext");
        var iv = new byte[ivLen];
        var body = new byte[data.Length - ivLen];
        Buffer.BlockCopy(data, 0, iv, 0, ivLen);
        Buffer.BlockCopy(data, ivLen, body, 0, body.Length);
        using var aes = Aes.Create();
        aes.Key = key;
        aes.IV = iv;
        using var dec = aes.CreateDecryptor();
        return dec.TransformFinalBlock(body, 0, body.Length);
    }
}