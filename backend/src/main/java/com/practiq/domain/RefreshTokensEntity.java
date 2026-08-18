package com.practiq.domain;
import com.baomidou.mybatisplus.annotation.*;
@TableName("refresh_tokens") public class RefreshTokensEntity { @TableId(value="id",type=IdType.AUTO) public Long id; }
