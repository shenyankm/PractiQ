package com.practiq.domain;
import com.baomidou.mybatisplus.annotation.*;
@TableName("auth_sessions") public class AuthSessionsEntity { @TableId(value="id",type=IdType.AUTO) public Long id; }
